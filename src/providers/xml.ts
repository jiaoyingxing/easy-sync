/**
 * 窄用途 XML 读取器（S3 与 WebDAV 共用）。
 *
 * 宿主（Chromium／WKWebView）有 DOMParser，测试环境（Node）没有——若生产与
 * 测试各用一套解析器，被测路径就被换掉了。因此两边都走这一个实现：
 *
 * - 只接受良构 XML：单个根元素、属性必须带引号、标签必须配对；
 * - 支持命名空间前缀（按 `localName` 查找即可）、五个预定义实体、十进制／
 *   十六进制数字实体、CDATA、自闭合标签、注释与处理指令；
 * - 不支持 DTD（遇到 `<!DOCTYPE` 直接报错），不展开外部实体；
 * - 截断、非法实体、标签不配对、尾部多余内容一律抛错，**不返回半份结果**。
 *
 * 这不是通用 XML 库：没有命名空间解析、没有 schema、没有流式读取。S3 与
 * WebDAV 的响应只用到元素树、属性与叶子文本，够用即可。
 */

/** XML 输入不合法。调用方应把它当作协议错误，不要当成「空结果」。 */
export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

/** 解析后的元素。`text` 只含该元素的直接文本／CDATA，不含子元素文本。 */
export interface XmlElement {
  /** 原始限定名（可能带前缀，如 `d:response`）。 */
  readonly name: string;
  /** 去掉前缀后的本地名；查找一律用它。 */
  readonly localName: string;
  readonly prefix: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  readonly text: string;
}

interface MutableElement {
  name: string;
  localName: string;
  prefix: string;
  attributes: Record<string, string>;
  children: MutableElement[];
  text: string;
}

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
});

/** 元素名允许除空白与结构字符以外的任意字符（覆盖命名空间前缀）。 */
function isNameCharacter(character: string): boolean {
  return !/\s/.test(character) && character !== "/" && character !== ">" && character !== "<" && character !== "=";
}

/**
 * 把 XML 字节解码为字符串。UTF-8 非法字节直接报错；`TextDecoder` 默认会
 * 吃掉 BOM，字符串入口另外手工去一次。
 */
export function decodeXmlBytes(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new XmlParseError("XML bytes are not valid UTF-8");
  }
}

/** 解析一份良构 XML；失败抛 `XmlParseError`。 */
export function parseXml(source: string): XmlElement {
  const parser = new XmlParser(source);
  return parser.parseDocument();
}

/** 取第一个本地名匹配的直接子元素。 */
export function findChild(element: XmlElement, localName: string): XmlElement | null {
  for (const child of element.children) {
    if (child.localName === localName) return child;
  }
  return null;
}

/** 取所有本地名匹配的直接子元素。 */
export function findChildren(element: XmlElement, localName: string): XmlElement[] {
  return element.children.filter((child) => child.localName === localName);
}

/** 取指定本地名子元素的直接文本；子元素不存在或文本为空时返回 null。 */
export function childText(element: XmlElement, localName: string): string | null {
  const child = findChild(element, localName);
  if (!child || child.text.length === 0) return null;
  return child.text;
}

class XmlParser {
  private position = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source.startsWith("\uFEFF") ? source.slice(1) : source;
  }

  parseDocument(): XmlElement {
    this.skipMisc();
    if (this.position >= this.source.length) {
      throw new XmlParseError("XML document is empty");
    }
    const root = this.parseElement();
    this.skipMisc();
    if (this.position < this.source.length) {
      throw new XmlParseError(`Unexpected trailing content at offset ${this.position}`);
    }
    return root;
  }

  private skipMisc(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.startsWith("<?")) {
        this.skipProcessingInstruction();
        continue;
      }
      if (this.startsWith("<!--")) {
        this.skipComment();
        continue;
      }
      if (this.startsWith("<!DOCTYPE") || this.startsWith("<!doctype")) {
        throw new XmlParseError("DOCTYPE is not supported");
      }
      return;
    }
  }

  private parseElement(): MutableElement {
    this.expect("<");
    if (this.startsWith("/")) {
      throw new XmlParseError(`Unexpected closing tag at offset ${this.position}`);
    }
    const name = this.readName();
    if (name.length === 0) {
      throw new XmlParseError(`Missing element name at offset ${this.position}`);
    }
    const element: MutableElement = {
      name,
      localName: localNameOf(name),
      prefix: prefixOf(name),
      attributes: {},
      children: [],
      text: "",
    };
    for (;;) {
      this.skipWhitespace();
      if (this.startsWith("/>")) {
        this.position += 2;
        return element;
      }
      if (this.startsWith(">")) {
        this.position += 1;
        break;
      }
      if (this.position >= this.source.length) {
        throw new XmlParseError(`Truncated opening tag <${name}>`);
      }
      const attributeName = this.readName();
      if (attributeName.length === 0) {
        throw new XmlParseError(`Invalid attribute in <${name}> at offset ${this.position}`);
      }
      if (Object.prototype.hasOwnProperty.call(element.attributes, attributeName)) {
        throw new XmlParseError(`Duplicate attribute ${attributeName} in <${name}>`);
      }
      this.skipWhitespace();
      this.expect("=");
      this.skipWhitespace();
      element.attributes[attributeName] = this.readAttributeValue();
    }
    this.parseContent(element);
    return element;
  }

  private parseContent(element: MutableElement): void {
    for (;;) {
      if (this.position >= this.source.length) {
        throw new XmlParseError(`Truncated content in <${element.name}>`);
      }
      if (this.startsWith("</")) {
        this.position += 2;
        const closingName = this.readName();
        if (closingName !== element.name) {
          throw new XmlParseError(
            `Mismatched closing tag </${closingName}> for <${element.name}>`,
          );
        }
        this.skipWhitespace();
        this.expect(">");
        return;
      }
      if (this.startsWith("<![CDATA[")) {
        this.position += "<![CDATA[".length;
        const end = this.source.indexOf("]]>", this.position);
        if (end < 0) {
          throw new XmlParseError(`Unterminated CDATA in <${element.name}>`);
        }
        element.text += this.source.slice(this.position, end);
        this.position = end + 3;
        continue;
      }
      if (this.startsWith("<!--")) {
        this.skipComment();
        continue;
      }
      if (this.startsWith("<?")) {
        this.skipProcessingInstruction();
        continue;
      }
      if (this.startsWith("<!")) {
        throw new XmlParseError(`Unsupported markup declaration at offset ${this.position}`);
      }
      if (this.startsWith("<")) {
        element.children.push(this.parseElement());
        continue;
      }
      const end = this.source.indexOf("<", this.position);
      const raw = end < 0 ? this.source.slice(this.position) : this.source.slice(this.position, end);
      if (end < 0) {
        throw new XmlParseError(`Truncated text in <${element.name}>`);
      }
      element.text += decodeEntities(raw);
      this.position = end;
    }
  }

  private readName(): string {
    const start = this.position;
    while (this.position < this.source.length && isNameCharacter(this.source[this.position])) {
      this.position += 1;
    }
    return this.source.slice(start, this.position);
  }

  private readAttributeValue(): string {
    const quote = this.source[this.position];
    if (quote !== '"' && quote !== "'") {
      throw new XmlParseError(`Attribute value must be quoted at offset ${this.position}`);
    }
    this.position += 1;
    const end = this.source.indexOf(quote, this.position);
    if (end < 0) {
      throw new XmlParseError(`Unterminated attribute value at offset ${this.position}`);
    }
    const raw = this.source.slice(this.position, end);
    this.position = end + 1;
    return decodeEntities(raw);
  }

  private skipWhitespace(): void {
    while (this.position < this.source.length && /\s/.test(this.source[this.position])) {
      this.position += 1;
    }
  }

  private skipComment(): void {
    const end = this.source.indexOf("-->", this.position + "<!--".length);
    if (end < 0) {
      throw new XmlParseError("Unterminated XML comment");
    }
    this.position = end + 3;
  }

  private skipProcessingInstruction(): void {
    const end = this.source.indexOf("?>", this.position + 2);
    if (end < 0) {
      throw new XmlParseError("Unterminated processing instruction");
    }
    this.position = end + 2;
  }

  private startsWith(token: string): boolean {
    return this.source.startsWith(token, this.position);
  }

  private expect(token: string): void {
    if (!this.startsWith(token)) {
      throw new XmlParseError(`Expected "${token}" at offset ${this.position}`);
    }
    this.position += token.length;
  }
}

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  let result = "";
  let cursor = 0;
  while (cursor < raw.length) {
    const ampersand = raw.indexOf("&", cursor);
    if (ampersand < 0) {
      result += raw.slice(cursor);
      break;
    }
    result += raw.slice(cursor, ampersand);
    const semicolon = raw.indexOf(";", ampersand + 1);
    if (semicolon < 0) {
      throw new XmlParseError("Unterminated entity reference");
    }
    const body = raw.slice(ampersand + 1, semicolon);
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const codePoint = Number.parseInt(body.slice(2), 16);
      result += String.fromCodePoint(assertCodePoint(codePoint, body));
    } else if (body.startsWith("#")) {
      const codePoint = Number.parseInt(body.slice(1), 10);
      result += String.fromCodePoint(assertCodePoint(codePoint, body));
    } else {
      const replacement = PREDEFINED_ENTITIES[body];
      if (replacement === undefined) {
        throw new XmlParseError(`Unknown entity &${body};`);
      }
      result += replacement;
    }
    cursor = semicolon + 1;
  }
  return result;
}

function assertCodePoint(codePoint: number, raw: string): number {
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
    throw new XmlParseError(`Invalid character reference &${raw};`);
  }
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    throw new XmlParseError(`Surrogate character reference &${raw}; is not allowed`);
  }
  return codePoint;
}

function localNameOf(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function prefixOf(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon < 0 ? "" : name.slice(0, colon);
}
