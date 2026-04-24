import * as vscode from 'vscode';
import * as path from 'path';
import {
    SUSPEND_DECLARATION_KINDS,
    SuspendKind,
    SuspensionPoint,
    analyze,
} from './coroutineAnalyzer';

const KOTLIN_LANG = 'kotlin';
const DEBOUNCE_MS = 75;

/** Per-document analysis cache so hover / codelens / status bar share a single pass. */
interface DocCache {
    version: number;
    points: SuspensionPoint[];
}
const cache = new Map<string, DocCache>();

/**
 * One decoration type per gutter glyph. We map each `SuspendKind` to one of
 * the JetBrains icons (call vs declaration vs function vs method). The
 * extension API does not let a single decoration type pick its icon per range,
 * so we render N small batches instead.
 */
const gutterDecorations = new Map<GutterIconId, vscode.TextEditorDecorationType>();
type GutterIconId = 'call' | 'declaration' | 'function' | 'method';
/** Subtle underline-style decoration used to make suspend calls visually distinct. */
let inlineDecoration: vscode.TextEditorDecorationType;

let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('Kotlinx Coroutines Insight');
    context.subscriptions.push(output);

    const makeGutter = (lightFile: string, darkFile: string) =>
        vscode.window.createTextEditorDecorationType({
            gutterIconSize: 'contain',
            light: { gutterIconPath: vscode.Uri.file(path.join(context.extensionPath, 'images', lightFile)) },
            dark: { gutterIconPath: vscode.Uri.file(path.join(context.extensionPath, 'images', darkFile)) },
        });
    gutterDecorations.set('call', makeGutter('suspendCall.svg', 'suspendCall_dark.svg'));
    gutterDecorations.set('declaration', makeGutter('suspendDeclaration.svg', 'suspendDeclaration_dark.svg'));
    gutterDecorations.set('function', makeGutter('suspendFunction.svg', 'suspendFunction_dark.svg'));
    gutterDecorations.set('method', makeGutter('suspendMethod.svg', 'suspendMethod_dark.svg'));

    inlineDecoration = vscode.window.createTextEditorDecorationType({
        // A faint dotted underline is the cheapest way to convey "this resumes the
        // coroutine here" without fighting the user's syntax theme.
        textDecoration: 'underline dotted rgba(127,82,255,0.55)',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    for (const dec of gutterDecorations.values()) context.subscriptions.push(dec);
    context.subscriptions.push(inlineDecoration);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'kotlinxCoroutines.gotoNextSuspendPoint';
    context.subscriptions.push(statusBar);

    // ── Listeners ─────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => scheduleUpdate(editor)),
        vscode.workspace.onDidChangeTextDocument(e => {
            const editor = vscode.window.activeTextEditor;
            if (editor && e.document === editor.document) scheduleUpdate(editor);
        }),
        vscode.workspace.onDidOpenTextDocument(doc => {
            const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
            if (editor) scheduleUpdate(editor);
        }),
        vscode.workspace.onDidCloseTextDocument(doc => {
            cache.delete(doc.uri.toString());
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('kotlinxCoroutines')) {
                cache.clear();
                for (const editor of vscode.window.visibleTextEditors) scheduleUpdate(editor);
            }
        }),
    );

    // ── Providers ─────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(KOTLIN_LANG, new CoroutineHoverProvider()),
        vscode.languages.registerCodeLensProvider(KOTLIN_LANG, new CoroutineCodeLensProvider()),
        vscode.languages.registerInlayHintsProvider(KOTLIN_LANG, new CoroutineInlayHintsProvider()),
    );

    // ── Commands ──────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('kotlinxCoroutines.refresh', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                cache.delete(editor.document.uri.toString());
                updateNow(editor);
            }
        }),
        vscode.commands.registerCommand('kotlinxCoroutines.toggleGutterIcons', async () => {
            const cfg = vscode.workspace.getConfiguration('kotlinxCoroutines');
            const next = !cfg.get<boolean>('gutterIcons.enabled', true);
            await cfg.update('gutterIcons.enabled', next, vscode.ConfigurationTarget.Workspace);
            output.appendLine(`Suspension gutter icons ${next ? 'enabled' : 'disabled'}.`);
        }),
        vscode.commands.registerCommand('kotlinxCoroutines.gotoNextSuspendPoint', () => navigate(+1)),
        vscode.commands.registerCommand('kotlinxCoroutines.gotoPreviousSuspendPoint', () => navigate(-1)),
    );

    // Initial pass on whatever editor is open.
    if (vscode.window.activeTextEditor) updateNow(vscode.window.activeTextEditor);
}

export function deactivate(): void {
    if (debounceHandle) clearTimeout(debounceHandle);
}

// ─────────────────────────────────────────────────────────────────────────────
// Update pipeline
// ─────────────────────────────────────────────────────────────────────────────

let debounceHandle: NodeJS.Timeout | undefined;
let pendingEditor: vscode.TextEditor | undefined;

function scheduleUpdate(editor: vscode.TextEditor | undefined): void {
    if (!editor || editor.document.languageId !== KOTLIN_LANG) {
        // Hide the status bar when the user navigates away from a Kotlin file.
        statusBar.hide();
        return;
    }
    pendingEditor = editor;
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(() => {
        debounceHandle = undefined;
        if (pendingEditor) updateNow(pendingEditor);
    }, DEBOUNCE_MS);
}

function updateNow(editor: vscode.TextEditor): void {
    const doc = editor.document;
    if (doc.languageId !== KOTLIN_LANG) {
        statusBar.hide();
        return;
    }
    const points = getOrComputePoints(doc);
    applyDecorations(editor, points);
    refreshStatusBar(points);
}

function getOrComputePoints(doc: vscode.TextDocument): SuspensionPoint[] {
    const key = doc.uri.toString();
    const hit = cache.get(key);
    if (hit && hit.version === doc.version) return hit.points;
    const cfg = vscode.workspace.getConfiguration('kotlinxCoroutines');
    const points = analyze(doc.getText(), {
        extraSuspendFunctions: cfg.get<string[]>('extraSuspendFunctions') ?? [],
        extraCoroutineBuilders: cfg.get<string[]>('extraCoroutineBuilders') ?? [],
    });
    cache.set(key, { version: doc.version, points });
    return points;
}

function applyDecorations(editor: vscode.TextEditor, points: SuspensionPoint[]): void {
    const cfg = vscode.workspace.getConfiguration('kotlinxCoroutines');
    const showGutter = cfg.get<boolean>('gutterIcons.enabled', true);

    /** Buckets keyed by the icon family that should render the gutter glyph. */
    const buckets: Record<GutterIconId, vscode.DecorationOptions[]> = {
        call: [], declaration: [], function: [], method: [],
    };
    const inline: vscode.DecorationOptions[] = [];
    // Tracks (line, startChar, endChar) tuples already emitted so the legacy
    // `suspendFunctionDecl` alias does not produce a second gutter glyph on top
    // of the new `suspendFunction` / `suspendMethod` / `suspendDeclaration`
    // points (they share the same coordinates by design).
    const seen = new Set<string>();
    for (const p of points) {
        const key = `${p.line}:${p.startChar}:${p.endChar}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const range = new vscode.Range(p.line, p.startChar, p.line, p.endChar);
        if (showGutter) {
            buckets[gutterIconFor(p.kind)].push({ range, hoverMessage: hoverMarkdown(p) });
        }
        // Declarations get the gutter icon (for parity with IntelliJ) but no
        // dotted underline — the function name is already visually prominent.
        if (!SUSPEND_DECLARATION_KINDS.has(p.kind)) {
            inline.push({ range });
        }
    }
    for (const [id, dec] of gutterDecorations) {
        editor.setDecorations(dec, showGutter ? buckets[id] : []);
    }
    editor.setDecorations(inlineDecoration, inline);
}

/** Pick the JetBrains icon family appropriate for a given suspend kind. */
function gutterIconFor(kind: SuspendKind): GutterIconId {
    switch (kind) {
        case 'suspendMethod': return 'method';
        case 'suspendFunction': return 'function';
        case 'suspendDeclaration':
        case 'suspendFunctionDecl':
            return 'declaration';
        default:
            return 'call';
    }
}

function refreshStatusBar(points: SuspensionPoint[]): void {
    const cfg = vscode.workspace.getConfiguration('kotlinxCoroutines');
    if (!cfg.get<boolean>('statusBar.enabled', true)) {
        statusBar.hide();
        return;
    }
    const callPoints = points.filter(p => !SUSPEND_DECLARATION_KINDS.has(p.kind));
    if (callPoints.length === 0) {
        statusBar.hide();
        return;
    }
    statusBar.text = `$(sync~spin) ${callPoints.length} suspension point${callPoints.length === 1 ? '' : 's'}`;
    statusBar.tooltip = 'Click to jump to the next suspension point.';
    statusBar.show();
}

function hoverMarkdown(p: SuspensionPoint): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${kindLabel(p.kind)}** — \`${p.name}\`\n\n`);
    md.appendMarkdown(p.description);
    if (!p.insideSuspendContext && (p.kind === 'suspendCall' || p.kind === 'awaitCall' || p.kind === 'flowTerminal')) {
        md.appendMarkdown(`\n\n> ⚠ This suspending call appears outside of any \`suspend\` function or coroutine builder.`);
    }
    return md;
}

function kindLabel(kind: SuspendKind): string {
    switch (kind) {
        case 'coroutineBuilder': return 'Coroutine builder';
        case 'suspendCall': return 'Suspending call';
        case 'awaitCall': return 'Await';
        case 'flowTerminal': return 'Flow terminal';
        case 'suspendMethod': return 'Suspend method';
        case 'suspendFunction': return 'Suspend function';
        case 'suspendDeclaration':
        case 'suspendFunctionDecl':
            return 'Suspend declaration';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

function navigate(direction: 1 | -1): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== KOTLIN_LANG) return;
    const points = getOrComputePoints(editor.document)
        .filter(p => !SUSPEND_DECLARATION_KINDS.has(p.kind));
    if (points.length === 0) return;
    const cur = editor.selection.active;
    const ordered = direction === 1 ? points : [...points].reverse();
    const next = ordered.find(p =>
        direction === 1
            ? p.line > cur.line || (p.line === cur.line && p.startChar > cur.character)
            : p.line < cur.line || (p.line === cur.line && p.startChar < cur.character),
    ) ?? ordered[0]; // wrap around
    const pos = new vscode.Position(next.line, next.startChar);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// ─────────────────────────────────────────────────────────────────────────────
// Providers
// ─────────────────────────────────────────────────────────────────────────────

class CoroutineHoverProvider implements vscode.HoverProvider {
    provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.ProviderResult<vscode.Hover> {
        const points = getOrComputePoints(doc);
        const hit = points.find(p =>
            p.line === pos.line && pos.character >= p.startChar && pos.character <= p.endChar,
        );
        if (!hit) return undefined;
        return new vscode.Hover(
            hoverMarkdown(hit),
            new vscode.Range(hit.line, hit.startChar, hit.line, hit.endChar),
        );
    }
}

class CoroutineCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChange.event;

    provideCodeLenses(doc: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
        const cfg = vscode.workspace.getConfiguration('kotlinxCoroutines');
        if (!cfg.get<boolean>('codeLens.enabled', true)) return [];
        const points = getOrComputePoints(doc);
        // Use the legacy alias as the canonical declaration anchor — every
        // declaration emits exactly one of these alongside its specific kind.
        const decls = points.filter(p => p.kind === 'suspendFunctionDecl');
        const calls = points.filter(p => !SUSPEND_DECLARATION_KINDS.has(p.kind));
        const lenses: vscode.CodeLens[] = [];
        for (const d of decls) {
            const range = new vscode.Range(d.line, 0, d.line, 0);
            // Count call points whose line is greater than the decl line until the
            // next decl. This is an approximation but works well for normal layouts.
            const nextDecl = decls.find(o => o.line > d.line);
            const upper = nextDecl ? nextDecl.line : Number.MAX_SAFE_INTEGER;
            const inner = calls.filter(c => c.line > d.line && c.line < upper).length;
            const title = `$(sync) suspend · ${inner} suspension point${inner === 1 ? '' : 's'}`;
            lenses.push(new vscode.CodeLens(range, {
                title,
                command: 'kotlinxCoroutines.gotoNextSuspendPoint',
                tooltip: `Jump to the next suspension point inside ${d.name}`,
            }));
        }
        return lenses;
    }
}

class CoroutineInlayHintsProvider implements vscode.InlayHintsProvider {
    provideInlayHints(doc: vscode.TextDocument, range: vscode.Range): vscode.ProviderResult<vscode.InlayHint[]> {
        const cfg = vscode.workspace.getConfiguration('kotlinxCoroutines');
        if (!cfg.get<boolean>('inlayHints.enabled', true)) return [];
        const points = getOrComputePoints(doc);
        const hints: vscode.InlayHint[] = [];
        for (const p of points) {
            if (p.line < range.start.line || p.line > range.end.line) continue;
            if (SUSPEND_DECLARATION_KINDS.has(p.kind)) continue;
            const label = p.kind === 'awaitCall' ? 'await' : 'suspend';
            const hint = new vscode.InlayHint(
                new vscode.Position(p.line, p.endChar),
                ` ${label}`,
                vscode.InlayHintKind.Type,
            );
            hint.paddingLeft = true;
            hint.tooltip = hoverMarkdown(p);
            hints.push(hint);
        }
        return hints;
    }
}
