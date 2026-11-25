import { describe, expect, it } from "vitest";
import {
  childText,
  decodeXmlBytes,
  findChild,
  findChildren,
  parseXml,
  XmlParseError,
} from "../src/providers/xml";

/**
 * 窄 XML 读取器合同。测试环境没有 DOMParser（Node v24），生产有；两边必须
 * 走同一条路径，因此这里覆盖命名空间前缀、五个预定义实体、数字实体、CDATA、
 * 自闭合标签，以及截断／非法输入必须报错（不返回半份结果）。
 */
describe("良构 XML", () => {
  it("命名空间前缀与嵌套元素按 localName 查找", () => {
    const root = parseXml(
      '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/a%20b.md</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
    );
    expect(root.localName).toBe("multistatus");
    expect(root.prefix).toBe("d");
    const responses = findChildren(root, "response");
    expect(responses).toHaveLength(1);
    expect(childText(responses[0], "href")).toBe("/a%20b.md");
    expect(findChild(responses[0], "missing")).toBeNull();
  });

  it("五个预定义实体与十进制／十六进制数字实体", () => {
    const root = parseXml(
      "<r><v>&amp;&lt;&gt;&quot;&apos;</v><n>&#65;&#x1F600;</n></r>",
    );
    expect(childText(root, "v")).toBe("&<>\"'");
    expect(childText(root, "n")).toBe("A😀");
  });

  it("CDATA 保留原始内容，不再二次解析实体", () => {
    const root = parseXml("<r><v><![CDATA[a & b < c]]></v></r>");
    expect(childText(root, "v")).toBe("a & b < c");
  });

  it("自闭合标签、单双引号属性、注释与处理指令", () => {
    const root = parseXml(
      '<?xml version="1.0"?><!-- comment --><r a="1" b=\'2\'><empty/><!-- inner --><v>x</v></r>',
    );
    expect(root.attributes).toEqual({ a: "1", b: "2" });
    expect(findChild(root, "empty")?.text).toBe("");
    expect(childText(root, "v")).toBe("x");
  });

  it("文本中的 `>` 合法；叶子文本原样保留", () => {
    const root = parseXml("<r><v>1 > 0 &amp; 2</v></r>");
    expect(childText(root, "v")).toBe("1 > 0 & 2");
  });

  it("UTF-8 字节解码与 BOM", () => {
    const encoded = new TextEncoder().encode("\uFEFF<r><v>中文😀</v></r>");
    const root = parseXml(decodeXmlBytes(encoded.buffer as ArrayBuffer));
    expect(childText(root, "v")).toBe("中文😀");
    expect(parseXml("\uFEFF<r/>").localName).toBe("r");
  });
});

describe("非法输入必须报错", () => {
  it("截断：缺少闭合标签／未闭合 CDATA／未闭合注释", () => {
    expect(() => parseXml("<r><v>x</v>")).toThrow(XmlParseError);
    expect(() => parseXml("<r><![CDATA[x")).toThrow(XmlParseError);
    expect(() => parseXml("<r><!-- x")).toThrow(XmlParseError);
    expect(() => parseXml("")).toThrow(XmlParseError);
  });

  it("标签不配对、尾部多余内容、重复属性", () => {
    expect(() => parseXml("<r><v></x></r>")).toThrow(XmlParseError);
    expect(() => parseXml("<r/>trailing")).toThrow(XmlParseError);
    expect(() => parseXml('<r a="1" a="2"/>')).toThrow(XmlParseError);
  });

  it("未知实体、未终止实体、非法字符引用", () => {
    expect(() => parseXml("<r>&unknown;</r>")).toThrow(XmlParseError);
    expect(() => parseXml("<r>&amp</r>")).toThrow(XmlParseError);
    expect(() => parseXml("<r>&#0;</r>")).toThrow(XmlParseError);
    expect(() => parseXml("<r>&#xD800;</r>")).toThrow(XmlParseError);
    expect(() => parseXml("<r>&#x110000;</r>")).toThrow(XmlParseError);
  });

  it("DTD 与外部实体不展开", () => {
    expect(() => parseXml('<!DOCTYPE r [<!ENTITY x "y">]><r>&x;</r>')).toThrow(XmlParseError);
  });

  it("非法 UTF-8 字节解码报错", () => {
    const invalid = new Uint8Array([0x3c, 0x72, 0x3e, 0xff, 0x3c, 0x2f, 0x72, 0x3e]);
    expect(() => decodeXmlBytes(invalid.buffer as ArrayBuffer)).toThrow(XmlParseError);
  });
});
