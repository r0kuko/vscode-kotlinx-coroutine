import * as vscode from 'vscode';
import * as path from 'path';
import {
    SUSPEND_DECLARATION_KINDS,
    SuspendKind,
    SuspensionPoint,
    analyze,
    findWithContextBlocks,
} from './coroutineAnalyzer';
import { detectAntiPatterns } from './coroutineDiagnostics';

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

let output: vscode.OutputChannel;
let diagCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('Kotlinx Coroutines Insight');
    context.subscriptions.push(output);

    diagCollection = vscode.languages.createDiagnosticCollection('kotlinxCoroutines');
    context.subscriptions.push(diagCollection);

    const makeGutter = (lightFile: string, darkFile: string) =>
        vscode.window.createTextEditorDecorationType({
            gutterIconSize: 'contain',
            light: { gutterIconPath: vscode.Uri.file(path.join(context.extensionPath, 'images', lightFile)) },
            dark: { gutterIconPath: vscode.Uri.file(path.join(context.extensionPath, 'images', darkFile)) },
        });
    // Call-site suspension points use the overview ruler only — a gutter icon
    // on those lines blocks VS Code from registering debug breakpoint clicks.
    gutterDecorations.set('call', vscode.window.createTextEditorDecorationType({
        overviewRulerColor: 'rgba(127,82,255,0.6)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    }));
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
            diagCollection.delete(doc.uri);
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
        vscode.languages.registerCodeActionsProvider(
            KOTLIN_LANG,
            new CoroutineCodeActionsProvider(),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
        ),
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
    if (doc.languageId !== KOTLIN_LANG) return;
    const points = getOrComputePoints(doc);
    applyDecorations(editor, points);
    refreshDiagnostics(doc);
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

function refreshDiagnostics(doc: vscode.TextDocument): void {
    const cfg = vscode.workspace.getConfiguration('kotlinxCoroutines');
    if (!cfg.get<boolean>('diagnostics.enabled', true)) {
        diagCollection.delete(doc.uri);
        return;
    }
    const points = getOrComputePoints(doc);
    const problems = detectAntiPatterns(doc.getText(), points);
    const diags = problems.map(p => {
        const range = new vscode.Range(p.line, p.startChar, p.line, p.endChar);
        const sev =
            p.severity === 'error'       ? vscode.DiagnosticSeverity.Error
            : p.severity === 'warning'   ? vscode.DiagnosticSeverity.Warning
            : p.severity === 'information' ? vscode.DiagnosticSeverity.Information
            : vscode.DiagnosticSeverity.Hint;
        const d = new vscode.Diagnostic(range, p.message, sev);
        d.source = 'Kotlinx Coroutines';
        d.code = p.code;
        return d;
    });
    diagCollection.set(doc.uri, diags);
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

        // suspend / await labels at suspension call sites
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

        // withContext(Dispatchers.X) { … } — label the closing brace with // X
        const blocks = findWithContextBlocks(doc.getText());
        for (const b of blocks) {
            if (b.closeLine < range.start.line || b.closeLine > range.end.line) continue;
            // Skip if the block fits on a single line (the label would be noise).
            if (b.closeLine === b.openLine) continue;
            const hint = new vscode.InlayHint(
                new vscode.Position(b.closeLine, b.closeChar + 1),
                ` // ${b.dispatcherName}`,
                vscode.InlayHintKind.Type,
            );
            hint.tooltip = new vscode.MarkdownString(
                `Closing brace of \`withContext(Dispatchers.${b.dispatcherName})\``,
            );
            hints.push(hint);
        }

        return hints;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Code actions (quickfixes for anti-pattern diagnostics)
// ─────────────────────────────────────────────────────────────────────────────

class CoroutineCodeActionsProvider implements vscode.CodeActionProvider {
    provideCodeActions(
        doc: vscode.TextDocument,
        range: vscode.Range,
        ctx: vscode.CodeActionContext,
    ): vscode.ProviderResult<vscode.CodeAction[]> {
        const actions: vscode.CodeAction[] = [];
        const ourDiags = ctx.diagnostics.filter(d => d.source === 'Kotlinx Coroutines');

        for (const diag of ourDiags) {
            const code = typeof diag.code === 'object' ? String(diag.code.value) : String(diag.code);

            if (code === 'COR001') {
                // runBlocking → coroutineScope
                const action = new vscode.CodeAction(
                    'Replace with `coroutineScope { }`',
                    vscode.CodeActionKind.QuickFix,
                );
                action.edit = new vscode.WorkspaceEdit();
                action.edit.replace(doc.uri, diag.range, 'coroutineScope');
                action.diagnostics = [diag];
                action.isPreferred = true;
                actions.push(action);

            } else if (code === 'COR003') {
                // Thread.sleep(N) → delay(N)
                const lineText = doc.lineAt(diag.range.start.line).text;
                const fromChar = diag.range.start.character;
                const m = lineText.slice(fromChar).match(/Thread\s*\.\s*sleep\s*\(([^)]+)\)/);
                if (m) {
                    const fullRange = new vscode.Range(
                        diag.range.start.line, fromChar,
                        diag.range.start.line, fromChar + m[0].length,
                    );
                    const action = new vscode.CodeAction(
                        'Replace with `delay(…)`',
                        vscode.CodeActionKind.QuickFix,
                    );
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.replace(doc.uri, fullRange, `delay(${m[1].trim()})`);
                    action.diagnostics = [diag];
                    action.isPreferred = true;
                    actions.push(action);
                }

            } else if (code === 'COR004') {
                // async { body }.await() → withContext(coroutineContext) { body }
                const lineText = doc.lineAt(diag.range.start.line).text;
                const fromChar = diag.range.start.character;
                const m = lineText.slice(fromChar).match(/async\s*\{([^{}]*)\}\s*\.await\(\)/);
                if (m) {
                    const fullRange = new vscode.Range(
                        diag.range.start.line, fromChar,
                        diag.range.start.line, fromChar + m[0].length,
                    );
                    const action = new vscode.CodeAction(
                        'Replace with `withContext(coroutineContext) { … }`',
                        vscode.CodeActionKind.QuickFix,
                    );
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.replace(doc.uri, fullRange, `withContext(coroutineContext) {${m[1]}}`);
                    action.diagnostics = [diag];
                    action.isPreferred = true;
                    actions.push(action);
                }
            }
        }

        // "Add suspend modifier" for any suspension call outside a suspend context
        const points = getOrComputePoints(doc);
        const unsafePoints = points.filter(p =>
            !SUSPEND_DECLARATION_KINDS.has(p.kind) &&
            !p.insideSuspendContext &&
            p.line >= range.start.line &&
            p.line <= range.end.line,
        );
        if (unsafePoints.length > 0) {
            const funLine = findEnclosingFunLine(doc, range.start.line);
            if (funLine !== undefined) {
                const lineText = doc.lineAt(funLine).text;
                const funIdx = lineText.search(/\bfun\b/);
                if (funIdx !== -1) {
                    const action = new vscode.CodeAction(
                        'Add `suspend` modifier to enclosing function',
                        vscode.CodeActionKind.QuickFix,
                    );
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.insert(doc.uri, new vscode.Position(funLine, funIdx), 'suspend ');
                    actions.push(action);
                }
            }
        }

        return actions;
    }
}

/**
 * Walk backwards from `fromLine` to find the nearest enclosing non-suspend
 * function declaration. Returns `undefined` if none is found or if the
 * nearest match is already `suspend`.
 */
function findEnclosingFunLine(doc: vscode.TextDocument, fromLine: number): number | undefined {
    for (let i = fromLine; i >= 0; i--) {
        const text = doc.lineAt(i).text;
        if (/\bsuspend\s+fun\b/.test(text)) return undefined;
        if (/\bfun\s+[A-Za-z_`]/.test(text)) return i;
    }
    return undefined;
}
