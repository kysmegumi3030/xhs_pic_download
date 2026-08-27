#!/usr/bin/env python3
"""根据 shortcut.json 生成可导入的 iOS 快捷指令文件（.shortcut）"""

import plistlib
import uuid
import sys

OBJ = "￼"  # 变量占位符 (Object Replacement Character)


def uid():
    return str(uuid.uuid4()).upper()


# 各动作输出的 UUID
U_CLIP, U_URL, U_COOKIE = uid(), uid(), uid()
U_RESP, U_DICT, U_PICS, U_ERR = uid(), uid(), uid(), uid()
U_COUNT, U_MEDIA = uid(), uid()
G_IF, G_REPEAT = uid(), uid()


def out_ref(output_uuid, name):
    return {"Type": "ActionOutput", "OutputUUID": output_uuid, "OutputName": name}


def token(text, attachments=None):
    """构造 WFTextTokenString；attachments 为 [(位置, 引用)] 列表"""
    if not attachments:
        return {
            "Value": {"string": text, "attachmentsByRange": {}},
            "WFSerializationType": "WFTextTokenString",
        }
    by_range = {f"{{{pos}, 1}}": ref for pos, ref in attachments}
    return {
        "Value": {"string": text, "attachmentsByRange": by_range},
        "WFSerializationType": "WFTextTokenString",
    }


def var_only(ref):
    """整个字段就是一个变量（用于 WFInput 这类「变量专用」字段）"""
    return {"Value": ref, "WFSerializationType": "WFTextTokenAttachment"}


def var_text(ref):
    """
    整个字段是一个变量，但字段本身是「文本」类型（如 WFURL）。
    文本字段必须用 WFTextTokenString，把变量作为附件挂在占位符位置；
    若误用 WFTextTokenAttachment，快捷指令会认为该字段为空并报「未指定URL」。
    """
    return token(OBJ, [(0, ref)])


def var_input(ref):
    """
    数据流动作（获取词典值 / 计数 / 重复 / 存储到照片）的 WFInput 用单层 attachment。
    实测：改成双层 {Type: Variable, Variable: ...} 会导致输入解析为空，
    循环因此迭代 0 次且不报任何错。
    """
    return var_only(ref)


def var_condition(ref):
    """「如果」的条件输入是另一种形式，需 {Type: Variable, Variable: <attachment>} 双层"""
    return {"Type": "Variable", "Variable": var_only(ref)}


def repeat_item():
    """「重复项」是快捷指令内置的特殊变量，按名称引用"""
    return {"Type": "Variable", "VariableName": "Repeat Item"}


def dict_field(pairs):
    """构造 WFDictionaryFieldValue；pairs 为 [(键, 值token)]"""
    items = []
    for k, v in pairs:
        items.append({"WFItemType": 0, "WFKey": k, "WFValue": v})
    return {
        "Value": {"WFDictionaryFieldValueItems": items},
        "WFSerializationType": "WFDictionaryFieldValue",
    }


def action(identifier, params=None):
    return {
        "WFWorkflowActionIdentifier": identifier,
        "WFWorkflowActionParameters": params or {},
    }


SERVER_URL = "http://YOUR_SERVER_IP:7776/getXhsPicUrl"
COOKIE_PLACEHOLDER = "在此粘贴 Cookie，形如 a1=xxxxx; web_session=xxxxx"

actions = []

# 0. 说明注释
actions.append(action("is.workflow.actions.comment", {
    "WFCommentActionText":
        "小红书 & Instagram 图片下载\n\n"
        "使用前请修改下面两处「文本」动作：\n"
        f"1) 服务地址：把 YOUR_SERVER_IP 换成部署 kys00/xhs_dwd 的实际 IP 或域名\n"
        "2) Cookie：粘贴小红书网页版 Cookie（a1=...; web_session=...）\n\n"
        "用法：小红书或 Instagram App 内分享→复制链接，然后运行本快捷指令。\n"
        "服务端会自动判断链接来源并使用对应的下载方式。",
}))

# 1. 获取剪贴板
actions.append(action("is.workflow.actions.getclipboard", {"UUID": U_CLIP}))

# 2. 服务地址
actions.append(action("is.workflow.actions.gettext", {
    "UUID": U_URL,
    "WFTextActionText": token(SERVER_URL),
}))

# 3. Cookie
actions.append(action("is.workflow.actions.gettext", {
    "UUID": U_COOKIE,
    "WFTextActionText": token(COOKIE_PLACEHOLDER),
}))

# 4. POST 请求（JSON 请求体内联 shareText / xhsCookie）
actions.append(action("is.workflow.actions.downloadurl", {
    "UUID": U_RESP,
    "WFURL": var_text(out_ref(U_URL, "文本")),
    "WFHTTPMethod": "POST",
    "WFHTTPBodyType": "JSON",
    "WFJSONValues": dict_field([
        (token("shareText"), token(OBJ, [(0, out_ref(U_CLIP, "剪贴板"))])),
        (token("xhsCookie"), token(OBJ, [(0, out_ref(U_COOKIE, "文本"))])),
    ]),
    "WFHTTPHeaders": dict_field([
        (token("Content-Type"), token("application/json")),
    ]),
    "ShowHeaders": True,
}))

# 5. 把响应内容转成词典
# 「获取URL内容」的输出是文件/数据，不是词典。若直接喂给「获取词典值」，
# 取不到键 → picUrlArray 为空 → 循环 0 次且不报错。必须先显式转换。
actions.append(action("is.workflow.actions.detect.dictionary", {
    "UUID": U_DICT,
    "WFInput": var_input(out_ref(U_RESP, "URL 内容")),
}))

# 6. 取 picUrlArray
actions.append(action("is.workflow.actions.getvalueforkey", {
    "UUID": U_PICS,
    "WFInput": var_input(out_ref(U_DICT, "词典")),
    "WFDictionaryKey": token("picUrlArray"),
    "WFGetDictionaryValueType": "Value",
}))

# 7. 取 error
actions.append(action("is.workflow.actions.getvalueforkey", {
    "UUID": U_ERR,
    "WFInput": var_input(out_ref(U_DICT, "词典")),
    "WFDictionaryKey": token("error"),
    "WFGetDictionaryValueType": "Value",
}))

# 8. 如果 error 有值 → 弹窗并停止
actions.append(action("is.workflow.actions.conditional", {
    "GroupingIdentifier": G_IF,
    "WFControlFlowMode": 0,
    "WFInput": var_condition(out_ref(U_ERR, "词典值")),
    "WFCondition": 100,  # 有任意值
}))
actions.append(action("is.workflow.actions.alert", {
    "WFAlertActionTitle": token("小红书下载失败"),
    "WFAlertActionMessage": token(OBJ, [(0, out_ref(U_ERR, "词典值"))]),
    "WFAlertActionCancelButtonShown": False,
}))
actions.append(action("is.workflow.actions.exit"))
actions.append(action("is.workflow.actions.conditional", {
    "GroupingIdentifier": G_IF,
    "WFControlFlowMode": 2,
}))

# 9. 统计数量
actions.append(action("is.workflow.actions.count", {
    "UUID": U_COUNT,
    "WFInput": var_input(out_ref(U_PICS, "词典值")),
    "WFCountType": "Items",
}))

# 10. 逐个下载并保存
actions.append(action("is.workflow.actions.repeat.each", {
    "GroupingIdentifier": G_REPEAT,
    "WFControlFlowMode": 0,
    "WFInput": var_input(out_ref(U_PICS, "词典值")),
}))
actions.append(action("is.workflow.actions.downloadurl", {
    "UUID": U_MEDIA,
    "WFURL": var_text(repeat_item()),
    "WFHTTPMethod": "GET",
    "WFHTTPHeaders": dict_field([
        (token("User-Agent"), token(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15")),
        (token("Referer"), token("https://www.xiaohongshu.com/")),
    ]),
    "ShowHeaders": True,
}))
actions.append(action("is.workflow.actions.savetocameraroll", {
    "WFInput": var_input(out_ref(U_MEDIA, "URL 内容")),
}))
actions.append(action("is.workflow.actions.repeat.each", {
    "GroupingIdentifier": G_REPEAT,
    "WFControlFlowMode": 2,
}))

# 11. 完成通知
actions.append(action("is.workflow.actions.notification", {
    "WFNotificationActionTitle": token("小红书下载完成"),
    "WFNotificationActionBody": token(
        f"共保存 {OBJ} 个文件", [(4, out_ref(U_COUNT, "计数"))]),
}))

workflow = {
    "WFWorkflowClientVersion": "2605.0.3",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowTypes": ["NCWidget"],
    "WFWorkflowInputContentItemClasses": [],
    "WFWorkflowHasOutputFallback": False,
    "WFWorkflowHasShortcutInputVariables": False,
    "WFWorkflowImportQuestions": [],
    "WFWorkflowIcon": {
        "WFWorkflowIconStartColor": 4292093695,  # 红/粉色，接近 #FF2442
        "WFWorkflowIconGlyphNumber": 59511,
    },
    "WFWorkflowActions": actions,
}

out = sys.argv[1] if len(sys.argv) > 1 else "xhs_download.plist"
with open(out, "wb") as f:
    plistlib.dump(workflow, f, fmt=plistlib.FMT_BINARY)
print(f"wrote {out} ({len(actions)} actions)")
