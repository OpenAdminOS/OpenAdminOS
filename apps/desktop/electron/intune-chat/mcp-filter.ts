/**
 * A restricted reader for the OData filters an MCP query writer may put in
 * a filter param, such as Release Communications'
 * `products/any(p: p eq 'Microsoft Intune') and status eq 'Rolling out'`.
 *
 * A filter can name one item (`id eq 109560`) as well as an item param can,
 * so every comparison on a field that names an item passes the same
 * item-ID rule before anything is sent. A filter outside this grammar is
 * refused rather than guessed at, and the filter sent is the one rebuilt
 * from what was read, never the writer's raw text.
 *
 * Grammar (keywords in any case, sent in lower case):
 *
 *   filter     := and ("or" and)*
 *   and        := unary ("and" unary)*
 *   unary      := "not" unary | "(" filter ")" | call | predicate
 *   call       := ("contains" | "startswith" | "endswith") "(" path "," literal ")"
 *   predicate  := path "/" ("any" | "all") "(" name ":" filter ")"
 *               | path ("eq" | "ne" | "gt" | "ge" | "lt" | "le") literal
 *               | path "in" "(" literal ("," literal)* ")"
 *   path       := name ("/" name)*
 *   literal    := 'text' | number | date | "null" | "true" | "false"
 *
 * A literal stands right of its field, as the server's examples write it.
 */

/** The filter is outside the grammar above. */
export class McpFilterSyntaxError extends Error {}

/** A comparison on an item field names an ID the item-ID rule does not allow. The message is the field. */
export class McpFilterItemError extends Error {}

type LiteralKind = "string" | "number" | "date" | "null" | "true" | "false";
interface Literal { kind: LiteralKind; text: string }

type FilterNode =
  | { type: "or" | "and"; left: FilterNode; right: FilterNode }
  | { type: "not"; operand: FilterNode }
  | { type: "group"; inner: FilterNode }
  | { type: "compare"; path: string[]; op: string; value: Literal }
  | { type: "in"; path: string[]; values: Literal[] }
  | { type: "call"; name: string; path: string[]; value: Literal }
  | { type: "lambda"; path: string[]; quantifier: string; variable: string; body: FilterNode };

type Token =
  | { kind: "name"; text: string }
  | { kind: "punct"; text: string }
  | { kind: "literal"; literal: Literal };

const COMPARISONS = new Set(["eq", "ne", "gt", "ge", "lt", "le"]);
const CALLS = new Set(["contains", "startswith", "endswith"]);
const QUANTIFIERS = new Set(["any", "all"]);
const MAX_DEPTH = 24;
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?(?:Z|[+-]\d{2}:\d{2}))?/;
const NUMBER = /^-?\d+(?:\.\d+)?/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let rest = text;
  while (rest.length > 0) {
    const space = /^[ \t\r\n]+/.exec(rest);
    if (space) { rest = rest.slice(space[0].length); continue; }
    const char = rest[0]!;
    if ("(),:/".includes(char)) { tokens.push({ kind: "punct", text: char }); rest = rest.slice(1); continue; }
    if (char === "'") {
      let value = "";
      let index = 1;
      for (;;) {
        if (index >= rest.length) throw new McpFilterSyntaxError("a quoted value is not closed");
        if (rest[index] === "'") {
          if (rest[index + 1] === "'") { value += "'"; index += 2; continue; }
          break;
        }
        value += rest[index];
        index += 1;
      }
      tokens.push({ kind: "literal", literal: { kind: "string", text: value } });
      rest = rest.slice(index + 1);
      continue;
    }
    const date = DATE.exec(rest);
    const scalar = date ?? NUMBER.exec(rest);
    if (scalar) {
      if (/^[A-Za-z0-9_.]/.test(rest.slice(scalar[0].length))) throw new McpFilterSyntaxError(`"${rest.slice(0, 24)}" is not a number or date`);
      tokens.push({ kind: "literal", literal: { kind: date ? "date" : "number", text: scalar[0] } });
      rest = rest.slice(scalar[0].length);
      continue;
    }
    const name = NAME.exec(rest);
    if (name) { tokens.push({ kind: "name", text: name[0] }); rest = rest.slice(name[0].length); continue; }
    throw new McpFilterSyntaxError(`it holds "${char}", which an OData filter does not use here`);
  }
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): FilterNode {
    if (this.tokens.length === 0) throw new McpFilterSyntaxError("it is empty");
    const node = this.or(0);
    if (this.index < this.tokens.length) throw new McpFilterSyntaxError(`${this.describe(this.peek())} follows a complete filter`);
    return node;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  private describe(token: Token | undefined): string {
    if (!token) return "the end";
    return token.kind === "literal" ? (token.literal.kind === "string" ? "a quoted value" : `"${token.literal.text}"`) : `"${token.text}"`;
  }

  private keyword(word: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === "name" && token.text.toLowerCase() === word;
  }

  private punct(char: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === "punct" && token.text === char;
  }

  private expectPunct(char: string, after: string): void {
    if (!this.punct(char)) throw new McpFilterSyntaxError(`expected "${char}" after ${after}, found ${this.describe(this.peek())}`);
    this.index += 1;
  }

  private or(depth: number): FilterNode {
    let node = this.and(depth);
    while (this.keyword("or")) {
      this.index += 1;
      node = { type: "or", left: node, right: this.and(depth) };
    }
    return node;
  }

  private and(depth: number): FilterNode {
    let node = this.unary(depth);
    while (this.keyword("and")) {
      this.index += 1;
      node = { type: "and", left: node, right: this.unary(depth) };
    }
    return node;
  }

  private unary(depth: number): FilterNode {
    if (depth > MAX_DEPTH) throw new McpFilterSyntaxError("it nests too deeply");
    if (this.keyword("not")) {
      this.index += 1;
      return { type: "not", operand: this.unary(depth + 1) };
    }
    if (this.punct("(")) {
      this.index += 1;
      const inner = this.or(depth + 1);
      this.expectPunct(")", "a group");
      return { type: "group", inner };
    }
    const head = this.peek();
    if (head?.kind === "name" && CALLS.has(head.text.toLowerCase()) && this.punct("(", 1)) {
      this.index += 2;
      const path = this.path();
      this.expectPunct(",", path.join("/"));
      const value = this.literal(`${head.text.toLowerCase()}(${path.join("/")},`);
      if (value.kind !== "string") throw new McpFilterSyntaxError(`${head.text.toLowerCase()} takes a quoted value`);
      this.expectPunct(")", "the quoted value");
      return { type: "call", name: head.text.toLowerCase(), path, value };
    }
    return this.predicate(depth);
  }

  private predicate(depth: number): FilterNode {
    const path: string[] = [this.name()];
    while (this.punct("/")) {
      this.index += 1;
      const segment = this.name();
      if (QUANTIFIERS.has(segment.toLowerCase()) && this.punct("(")) {
        this.index += 1;
        const variable = this.name();
        this.expectPunct(":", variable);
        const body = this.or(depth + 1);
        this.expectPunct(")", "a lambda");
        return { type: "lambda", path, quantifier: segment.toLowerCase(), variable, body };
      }
      path.push(segment);
    }
    const op = this.peek();
    const field = path.join("/");
    if (op?.kind === "name" && COMPARISONS.has(op.text.toLowerCase())) {
      this.index += 1;
      return { type: "compare", path, op: op.text.toLowerCase(), value: this.literal(`${field} ${op.text.toLowerCase()}`) };
    }
    if (op?.kind === "name" && op.text.toLowerCase() === "in") {
      this.index += 1;
      this.expectPunct("(", `${field} in`);
      const values = [this.literal(`${field} in (`)];
      while (this.punct(",")) {
        this.index += 1;
        values.push(this.literal(`${field} in (`));
      }
      this.expectPunct(")", `${field} in (`);
      return { type: "in", path, values };
    }
    throw new McpFilterSyntaxError(`"${field}" is not followed by a comparison such as eq`);
  }

  private path(): string[] {
    const path = [this.name()];
    while (this.punct("/")) {
      this.index += 1;
      path.push(this.name());
    }
    return path;
  }

  private name(): string {
    const token = this.peek();
    if (token?.kind !== "name") throw new McpFilterSyntaxError(`expected a field name, found ${this.describe(token)}`);
    this.index += 1;
    return token.text;
  }

  private literal(after: string): Literal {
    const token = this.peek();
    if (token?.kind === "literal") { this.index += 1; return token.literal; }
    if (token?.kind === "name" && ["null", "true", "false"].includes(token.text.toLowerCase())) {
      this.index += 1;
      return { kind: token.text.toLowerCase() as LiteralKind, text: token.text.toLowerCase() };
    }
    throw new McpFilterSyntaxError(`expected a value after ${after}, found ${this.describe(token)}`);
  }
}

function literalText(literal: Literal): string {
  return literal.kind === "string" ? `'${literal.text.replace(/'/g, "''")}'` : literal.text;
}

export interface McpFilterItemCheck {
  /** Fields that name one item, compared without regard to case. */
  fields: readonly string[];
  /** How the server compares those fields. */
  literal: "number" | "string";
  /** The canonical ID to send for a value, or undefined when the item-ID rule refuses it. */
  itemId(value: string): string | undefined;
}

/**
 * Reads a filter, checks every value compared with an item field, and
 * returns the filter rebuilt from what was read, with each item ID in its
 * canonical form. A path names an item when any of its parts is an item
 * field, or when it starts with a lambda variable over an item field.
 */
export function canonicalMcpFilter(text: string, check: McpFilterItemCheck): string {
  const tree = new Parser(tokenize(text)).parse();
  const fields = new Set(check.fields.map((field) => field.toLowerCase()));
  const namesItem = (path: readonly string[], itemVariables: ReadonlySet<string>) =>
    path.some((part) => fields.has(part.toLowerCase())) || itemVariables.has(path[0]!);
  const itemLiteral = (literal: Literal, field: string): string => {
    const send = literal.kind === "string" || literal.kind === "number" ? check.itemId(literal.text) : undefined;
    if (send === undefined) throw new McpFilterItemError(field);
    if (check.literal === "number") {
      if (!/^\d+$/.test(send)) throw new McpFilterItemError(field);
      return send;
    }
    return literalText({ kind: "string", text: send });
  };
  const write = (node: FilterNode, itemVariables: ReadonlySet<string>): string => {
    switch (node.type) {
      case "or":
      case "and":
        return `${write(node.left, itemVariables)} ${node.type} ${write(node.right, itemVariables)}`;
      case "not":
        return `not ${write(node.operand, itemVariables)}`;
      case "group":
        return `(${write(node.inner, itemVariables)})`;
      case "compare": {
        const field = node.path.join("/");
        return `${field} ${node.op} ${namesItem(node.path, itemVariables) ? itemLiteral(node.value, field) : literalText(node.value)}`;
      }
      case "in": {
        const field = node.path.join("/");
        const item = namesItem(node.path, itemVariables);
        return `${field} in (${node.values.map((value) => (item ? itemLiteral(value, field) : literalText(value))).join(", ")})`;
      }
      case "call": {
        const field = node.path.join("/");
        return `${node.name}(${field}, ${namesItem(node.path, itemVariables) ? itemLiteral(node.value, field) : literalText(node.value)})`;
      }
      case "lambda": {
        // The variable of a lambda over an item field stands for item IDs in its body.
        const inner = new Set([...itemVariables].filter((name) => name !== node.variable));
        if (namesItem(node.path, itemVariables)) inner.add(node.variable);
        return `${node.path.join("/")}/${node.quantifier}(${node.variable}: ${write(node.body, inner)})`;
      }
    }
  };
  return write(tree, new Set());
}
