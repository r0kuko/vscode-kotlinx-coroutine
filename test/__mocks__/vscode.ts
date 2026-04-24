/** Minimal VS Code API mock used by the unit tests. */

export class Uri {
    readonly fsPath: string;
    readonly scheme = 'file';
    readonly path: string;
    private constructor(p: string) { this.fsPath = p; this.path = p; }
    static file(p: string): Uri { return new Uri(p); }
    toString(): string { return `file://${this.fsPath}`; }
}

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}
export class Range {
    constructor(
        public readonly startLine: number,
        public readonly startChar: number,
        public readonly endLine: number,
        public readonly endChar: number,
    ) {}
}
export class Selection extends Range {}

export class MarkdownString {
    value = '';
    isTrusted = false;
    supportThemeIcons = false;
    appendMarkdown(s: string) { this.value += s; return this; }
}

export class Hover {
    constructor(public readonly contents: unknown, public readonly range?: Range) {}
}

export class CodeLens {
    constructor(public readonly range: Range, public command?: unknown) {}
}

export enum InlayHintKind { Type = 1, Parameter = 2 }
export class InlayHint {
    paddingLeft = false;
    tooltip: unknown;
    constructor(
        public readonly position: Position,
        public readonly label: string,
        public readonly kind?: InlayHintKind,
    ) {}
}

export enum DecorationRangeBehavior { OpenOpen = 0, ClosedClosed = 1 }
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum TextEditorRevealType { Default = 0, InCenter = 1, InCenterIfOutsideViewport = 2, AtTop = 3 }

export const window = {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createOutputChannel: (_name: string) => ({
        appendLine: (_s: string) => {},
        append: (_s: string) => {},
        show: () => {},
        dispose: () => {},
    }),
    createTextEditorDecorationType: (_opts: unknown) => ({ dispose: () => {} }),
    createStatusBarItem: () => ({
        text: '', tooltip: '', command: undefined as unknown,
        show: () => {}, hide: () => {}, dispose: () => {},
    }),
    onDidChangeActiveTextEditor: (_fn: unknown) => ({ dispose: () => {} }),
};

export const workspace = {
    getConfiguration: (_section?: string, _scope?: unknown) => ({
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: async (_k: string, _v: unknown, _t?: unknown) => {},
    }),
    onDidChangeTextDocument: (_fn: unknown) => ({ dispose: () => {} }),
    onDidOpenTextDocument: (_fn: unknown) => ({ dispose: () => {} }),
    onDidCloseTextDocument: (_fn: unknown) => ({ dispose: () => {} }),
    onDidChangeConfiguration: (_fn: unknown) => ({ dispose: () => {} }),
};

export const languages = {
    registerHoverProvider: (_l: string, _p: unknown) => ({ dispose: () => {} }),
    registerCodeLensProvider: (_l: string, _p: unknown) => ({ dispose: () => {} }),
    registerInlayHintsProvider: (_l: string, _p: unknown) => ({ dispose: () => {} }),
};

export const commands = {
    registerCommand: (_id: string, _fn: unknown) => ({ dispose: () => {} }),
};

export class EventEmitter<T> {
    private fns: Array<(v: T) => void> = [];
    event = (fn: (v: T) => void) => { this.fns.push(fn); return { dispose: () => {} }; };
    fire(v: T) { for (const f of this.fns) f(v); }
}

export default { Uri, Position, Range, Selection, MarkdownString, Hover, CodeLens, InlayHint,
    InlayHintKind, DecorationRangeBehavior, StatusBarAlignment, ConfigurationTarget,
    TextEditorRevealType, window, workspace, languages, commands, EventEmitter };
