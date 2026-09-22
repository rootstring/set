/** markdown-it ships no types. */

export interface Token {
  type: string;
  tag: string;
  attrs: [string, string][] | null;
  map: [number, number] | null;
  nesting: number;
  level: number;
  children: Token[] | null;
  content: string;
  markup: string;
  info: string;
  meta: Record<string, unknown> | null;
  block: boolean;
  hidden: boolean;
  attrGet(name: string): string | null;
  attrSet(name: string, value: string): void;
}

export interface Env {
  references?: Record<string, { href: string; title: string }>;
  setFootnotes?: Set<string>;
  [key: string]: unknown;
}

export interface StateInline {
  src: string;
  pos: number;
  posMax: number;
  pending: string;
  tokens: Token[];
  env: Env;
  md: MarkdownIt;
  push(type: string, tag: string, nesting: number): Token;
  scanDelims(
    start: number,
    canSplitWord: boolean,
  ): { can_open: boolean; can_close: boolean };
}

export interface StateBlock {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount: number[];
  blkIndent: number;
  line: number;
  lineMax: number;
  parentType: string;
  env: Env;
  md: MarkdownIt;
  tokens: Token[];
  push(type: string, tag: string, nesting: number): Token;
  isEmpty(line: number): boolean;
  getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string;
}

export interface StateCore {
  src: string;
  tokens: Token[];
  env: Env;
  md: MarkdownIt;
  /** markdown-it re-exports its token class here, for core rules to make one. */
  Token: new (type: string, tag: string, nesting: number) => Token;
}

export type InlineRule = (state: StateInline, silent: boolean) => boolean;
export type BlockRule = (
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean;
export type CoreRule = (state: StateCore) => void;

interface RuleOptions {
  alt?: string[];
}

export interface Ruler<R> {
  __rules__: { name: string; fn: R }[];
  __find__(name: string): number;
  at(name: string, fn: R, options?: RuleOptions): void;
  before(beforeName: string, ruleName: string, fn: R, options?: RuleOptions): void;
  after(afterName: string, ruleName: string, fn: R, options?: RuleOptions): void;
  getRules(chain: string): R[];
}

export type RenderRule = (
  tokens: Token[],
  idx: number,
  options: unknown,
  env: Env,
  self: Renderer,
) => string;

export interface Renderer {
  rules: Record<string, RenderRule | undefined>;
  renderToken(tokens: Token[], idx: number, options: unknown): string;
}

export interface LinkifyMatch {
  index: number;
  lastIndex: number;
  url: string;
}

export interface Linkify {
  match(text: string): LinkifyMatch[] | null;
  set(options: Record<string, unknown>): Linkify;
  add(schema: string, definition: Record<string, unknown>): Linkify;
}

export interface MarkdownIt {
  inline: {
    ruler: Ruler<InlineRule>;
    State: new (src: string, md: MarkdownIt, env: Env, tokens: Token[]) => StateInline;
  };
  block: { ruler: Ruler<BlockRule> };
  core: { ruler: Ruler<CoreRule> };
  renderer: Renderer;
  linkify: Linkify;
  helpers: {
    parseLinkLabel(state: StateInline, start: number, disableNested?: boolean): number;
  };
  utils: {
    escapeHtml(text: string): string;
    normalizeReference(label: string): string;
  };
  normalizeLink(url: string): string;
  set(options: Record<string, unknown>): MarkdownIt;
  use(plugin: (md: MarkdownIt) => void): MarkdownIt;
}

/** Swap a rule for one that wraps it, keeping its place in the chain. */
export function wrapRule<R>(
  ruler: Ruler<R>,
  name: string,
  wrap: (original: R) => R,
): void {
  const index = ruler.__find__(name);
  if (index < 0) throw new Error(`markdown-it has no rule named ${name}`);
  ruler.at(name, wrap(ruler.__rules__[index].fn));
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
