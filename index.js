// QR Panel - run existing Quick Replies in a separate floating panel.
// Results are stored per chat (chat metadata) and never written into the chat itself.

const MODULE_NAME = 'qr_panel';
const META_KEY = 'qr_panel';
const LOG_PREFIX = '[QR Panel]';
const TRANSLATE_BUFFER_VAR = 'qr_panel_translate_buffer';

// ---------------------------------------------------------------------------
// Model-facing prompts (English by design; editable in the settings)
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `You are an assistant working in a side panel next to an ongoing roleplay chat between {{user}} and {{char}}.
Your reply is shown only in this side panel. It is never added to the story, and the characters never see it.
Follow the instruction using the provided context (character information, story summary, recent messages).
Do not continue the roleplay or write the next chat message unless the instruction explicitly asks for it.`;

const DEFAULT_SUMMARY_PROMPT = `Write a concise summary of the story so far for later reference.
Cover the key events in order, important facts, relationships, each character's current state and goals, and unresolved plot threads.
If a previous summary is provided, merge it with the new messages into one updated summary instead of repeating it.
Output only the summary text.`;

// ---------------------------------------------------------------------------
// UI constants (Korean UI)
// ---------------------------------------------------------------------------

const LANGUAGES = [
    ['', '지정 안 함'],
    ['Korean', '한국어'],
    ['English', 'English'],
    ['Japanese', '日本語'],
    ['Simplified Chinese', '简体中文'],
    ['Traditional Chinese', '繁體中文'],
    ['__custom', '직접 입력…'],
];

const CONTEXT_MODES = {
    recent: '최근 대화',
    summary: '요약',
    both: '요약+최근',
};
const MODE_ORDER = ['recent', 'summary', 'both'];

// Slash commands that write into the chat or the main prompt; the panel cannot capture them.
const CHAT_WRITING_COMMANDS = [
    'send', 'sendas', 'sys', 'nar', 'narrate', 'comment', 'trigger', 'continue', 'cont',
    'impersonate', 'imp', 'addswipe', 'swipes-add', 'message-edit', 'messages-edit', 'cut', 'del',
    'inject', 'echo-to-chat', 'sendfile',
];

const defaultSettings = Object.freeze({
    profileId: '',
    maxTokens: 1024,
    outputLanguage: '',
    customLanguage: '',
    defaultMode: 'recent',
    recentCount: 20,
    summaryRange: 60,
    includeCharInfo: true,
    showHidden: true,
    enabledSets: null,
    qrModes: {},
    translateCommand: '/translate {{text}}',
    autoTranslate: false,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
    maxHistory: 200,
    panel: { left: null, top: null, width: 440, height: 620, open: false },
});

/** In-flight runs, keyed by entry id. Kept in memory only, so a chat switch never stores half-done entries. */
const pendingRuns = new Map();
/** Entry ids currently showing the original text instead of the translation. */
const showOriginal = new Set();
let summaryBusy = false;

// ---------------------------------------------------------------------------
// Settings and per-chat state
// ---------------------------------------------------------------------------

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = structuredClone(defaultSettings[key]);
        }
    }
    s.panel = Object.assign({}, defaultSettings.panel, s.panel);
    if (!s.qrModes || typeof s.qrModes !== 'object') s.qrModes = {};
    return s;
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function getCurrentChatId() {
    const ctx = SillyTavern.getContext();
    return ctx.getCurrentChatId?.() ?? ctx.chatId ?? null;
}

/** Per-chat panel state stored in chat metadata. Returns null when no chat is open. */
function getChatState() {
    const ctx = SillyTavern.getContext();
    if (!getCurrentChatId() || !ctx.chatMetadata) return null;
    const meta = ctx.chatMetadata;
    if (!meta[META_KEY] || typeof meta[META_KEY] !== 'object') {
        meta[META_KEY] = { summary: '', summaryUpdatedAt: null, history: [] };
    }
    const state = meta[META_KEY];
    if (!Array.isArray(state.history)) state.history = [];
    if (typeof state.summary !== 'string') state.summary = '';
    return state;
}

async function saveChatState() {
    await SillyTavern.getContext().saveMetadata();
}

function getOutputLanguage() {
    const s = getSettings();
    if (s.outputLanguage === '__custom') return s.customLanguage.trim();
    return s.outputLanguage;
}

function getMode(setName, label) {
    const s = getSettings();
    const mode = s.qrModes[`${setName}::${label}`];
    return CONTEXT_MODES[mode] ? mode : (CONTEXT_MODES[s.defaultMode] ? s.defaultMode : 'recent');
}

function cycleMode(setName, label) {
    const s = getSettings();
    const next = MODE_ORDER[(MODE_ORDER.indexOf(getMode(setName, label)) + 1) % MODE_ORDER.length];
    s.qrModes[`${setName}::${label}`] = next;
    saveSettings();
    return next;
}

// ---------------------------------------------------------------------------
// Quick Reply access
// ---------------------------------------------------------------------------

function getQrApi() {
    return globalThis.quickReplyApi ?? null;
}

/** @returns {{name: string, qrs: any[]}[]} */
function getVisibleSets() {
    const api = getQrApi();
    if (!api) return [];
    const s = getSettings();
    let names = [];
    try {
        names = api.listSets();
    } catch (err) {
        console.warn(LOG_PREFIX, 'listSets failed', err);
        return [];
    }
    if (Array.isArray(s.enabledSets)) {
        names = names.filter(n => s.enabledSets.includes(n));
    }
    return names.map(name => {
        const set = api.getSetByName(name);
        const qrs = (set?.qrList ?? []).filter(qr => s.showHidden || !qr.isHidden);
        return { name, qrs };
    }).filter(group => group.qrs.length > 0);
}

function findQr(setName, qrId, label) {
    const api = getQrApi();
    const set = api?.getSetByName(setName);
    if (!set) return null;
    return set.qrList.find(qr => qr.id === qrId) ?? set.qrList.find(qr => qr.label === label) ?? null;
}

function isScriptQr(qr) {
    return String(qr?.message ?? '').trimStart().startsWith('/');
}

function findChatWritingCommands(script) {
    const found = new Set();
    const re = /(?:^|\||\{:|\n)\s*\/([a-z][\w-]*)/gi;
    let m;
    while ((m = re.exec(script)) !== null) {
        const name = m[1].toLowerCase();
        if (CHAT_WRITING_COMMANDS.includes(name)) found.add(`/${name}`);
    }
    return [...found];
}

// ---------------------------------------------------------------------------
// Context building
// ---------------------------------------------------------------------------

function formatRecentMessages(count) {
    const { chat } = SillyTavern.getContext();
    if (!Array.isArray(chat) || count <= 0) return '';
    return chat
        .filter(m => m && !m.is_system && typeof m.mes === 'string' && m.mes.trim())
        .slice(-count)
        .map(m => `${m.name}: ${m.mes.trim()}`)
        .join('\n\n');
}

function getCharacterInfo() {
    const ctx = SillyTavern.getContext();
    let fields = {};
    try {
        fields = ctx.getCharacterCardFields?.() ?? {};
    } catch (err) {
        console.warn(LOG_PREFIX, 'getCharacterCardFields failed', err);
    }
    const parts = [];
    if (fields.description?.trim()) parts.push(`Character description (${ctx.name2}):\n${fields.description.trim()}`);
    if (fields.personality?.trim()) parts.push(`Personality:\n${fields.personality.trim()}`);
    if (fields.scenario?.trim()) parts.push(`Scenario:\n${fields.scenario.trim()}`);
    if (fields.persona?.trim()) parts.push(`User persona (${ctx.name1}):\n${fields.persona.trim()}`);
    return parts.join('\n\n');
}

/** Builds the context block for a run. Falls back to recent messages when the summary is empty. */
function buildContextBlock(mode) {
    const s = getSettings();
    const parts = [];
    let effectiveMode = mode;
    const summary = getChatState()?.summary?.trim() ?? '';

    if ((mode === 'summary' || mode === 'both') && !summary) {
        effectiveMode = 'recent';
        toastr.info('이 채팅의 요약이 비어 있어서 최근 대화로 대신 실행했어요.', 'QR 패널');
    }
    if (s.includeCharInfo) {
        const info = getCharacterInfo();
        if (info) parts.push(`<character_info>\n${info}\n</character_info>`);
    }
    if (effectiveMode === 'summary' || effectiveMode === 'both') {
        parts.push(`<story_summary>\n${summary}\n</story_summary>`);
    }
    if (effectiveMode === 'recent' || effectiveMode === 'both') {
        const log = formatRecentMessages(Number(s.recentCount) || 0);
        if (log) parts.push(`<recent_messages>\n${log}\n</recent_messages>`);
    }
    return { text: parts.join('\n\n'), mode: effectiveMode };
}

function buildSystemPrompt() {
    const ctx = SillyTavern.getContext();
    const s = getSettings();
    let prompt = ctx.substituteParams(s.systemPrompt || DEFAULT_SYSTEM_PROMPT);
    const lang = getOutputLanguage();
    if (lang) prompt += `\n\nWrite your entire response in ${lang}.`;
    return prompt;
}

function buildUserPrompt(contextText, instruction) {
    const lang = getOutputLanguage();
    const parts = [];
    if (contextText) parts.push(contextText);
    parts.push(`<instruction>\n${instruction}\n</instruction>`);
    if (lang) parts.push(`(Respond in ${lang}.)`);
    return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function getProfiles() {
    const ctx = SillyTavern.getContext();
    try {
        return ctx.ConnectionManagerRequestService?.getSupportedProfiles?.() ?? [];
    } catch {
        return [];
    }
}

function getProfileLabel() {
    const s = getSettings();
    if (!s.profileId) return '현재 연결';
    return getProfiles().find(p => p.id === s.profileId)?.name ?? '알 수 없는 프로필';
}

function errorText(err) {
    const cause = err?.cause?.message ?? err?.cause?.error?.message;
    const msg = err?.message ?? String(err);
    return cause ? `${msg}: ${cause}` : msg;
}

async function generateText({ system, user, signal }) {
    const ctx = SillyTavern.getContext();
    const s = getSettings();
    const maxTokens = Math.max(16, Number(s.maxTokens) || 1024);

    if (s.profileId) {
        const service = ctx.ConnectionManagerRequestService;
        if (!service) throw new Error('이 ST 버전에서는 연결 프로필로 생성할 수 없어요. 연결 프로필을 "현재 연결"로 바꿔 주세요.');
        const messages = [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ];
        const result = await service.sendRequest(s.profileId, messages, maxTokens, {
            stream: false,
            signal,
            extractData: true,
            includePreset: true,
        });
        return typeof result === 'string' ? result : String(result?.content ?? '');
    }

    const result = await ctx.generateRaw({ systemPrompt: system, prompt: user, responseLength: maxTokens });
    return String(result ?? '');
}

async function runScriptQr(setName, qr, contextText) {
    const api = getQrApi();
    const set = api?.getSetByName(setName);
    // isRun=true makes the Quick Reply extension execute the script directly and return the pipe value.
    if (set && !set.disableSend && typeof qr.execute === 'function') {
        const result = await qr.execute({ context: contextText }, false, true, {});
        return String(result ?? '');
    }
    const ctx = SillyTavern.getContext();
    const result = await ctx.executeSlashCommandsWithOptions(qr.message, {
        handleParserErrors: true,
        source: `${setName}.${qr.label}`,
    });
    return String(result?.pipe ?? '');
}

// ---------------------------------------------------------------------------
// Running Quick Replies
// ---------------------------------------------------------------------------

async function runQr(setName, qrId, label) {
    const ctx = SillyTavern.getContext();
    const chatId = getCurrentChatId();
    if (!chatId) {
        toastr.warning('먼저 채팅을 열어 주세요.', 'QR 패널');
        return;
    }
    const qr = findQr(setName, qrId, label);
    if (!qr) {
        toastr.error(`QR을 찾을 수 없어요: ${setName} / ${label}`, 'QR 패널');
        return;
    }
    const message = String(qr.message ?? '');
    if (!message.trim()) {
        toastr.info('내용이 비어 있는 QR이에요.', 'QR 패널');
        return;
    }

    const isScript = isScriptQr(qr);
    if (isScript) {
        const risky = findChatWritingCommands(message);
        if (risky.length) {
            const ok = await ctx.Popup.show.confirm(
                '채팅에 기록될 수 있어요',
                `이 QR에는 채팅이나 본 대화 프롬프트에 직접 쓰는 명령(${risky.join(', ')})이 들어 있어요. QR 패널은 이 명령의 결과를 가로챌 수 없어서 본 채팅에 기록될 수 있어요. 그래도 실행할까요?`,
            );
            if (ok !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
        }
    }

    const requestedMode = getMode(setName, qr.label);
    const entry = {
        id: ctx.uuidv4 ? ctx.uuidv4() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        set: setName,
        qrId: qr.id,
        label: qr.label,
        kind: isScript ? 'script' : 'prompt',
        mode: requestedMode,
        profile: isScript ? '' : getProfileLabel(),
        language: isScript ? '' : getOutputLanguage(),
        at: Date.now(),
        output: '',
        error: null,
        translation: null,
    };
    const run = {
        chatId,
        entry,
        abort: new AbortController(),
        usesMainConnection: !isScript && !getSettings().profileId,
        stopped: false,
    };
    pendingRuns.set(entry.id, run);
    renderHistory(true);

    try {
        const context = buildContextBlock(requestedMode);
        entry.mode = context.mode;
        if (isScript) {
            entry.output = (await runScriptQr(setName, qr, context.text)).trim();
            if (!entry.output) entry.output = '(스크립트가 반환한 값이 없어요. 스크립트 마지막 명령의 결과가 패널에 표시돼요.)';
        } else {
            const instruction = ctx.substituteParams(message);
            entry.output = (await generateText({
                system: buildSystemPrompt(),
                user: buildUserPrompt(context.text, instruction),
                signal: run.abort.signal,
            })).trim();
            if (!entry.output) entry.error = 'AI가 빈 응답을 보냈어요.';
        }
    } catch (err) {
        console.error(LOG_PREFIX, err);
        entry.error = errorText(err);
    } finally {
        pendingRuns.delete(entry.id);
    }

    if (run.stopped) {
        renderHistory();
        return;
    }
    await commitEntry(run);
    if (getSettings().autoTranslate && entry.output && !entry.error) {
        await translateEntry(entry.id);
    }
}

async function commitEntry(run) {
    if (getCurrentChatId() !== run.chatId) {
        toastr.warning(`"${run.entry.label}" 결과가 나오기 전에 채팅이 바뀌어서 저장하지 못했어요.`, 'QR 패널');
        renderHistory();
        return;
    }
    const state = getChatState();
    if (!state) return;
    state.history.push(run.entry);
    const max = Math.max(1, Number(getSettings().maxHistory) || 200);
    if (state.history.length > max) state.history.splice(0, state.history.length - max);
    await saveChatState();
    renderHistory(true);
}

function stopRun(id) {
    const run = pendingRuns.get(id);
    if (!run) return;
    run.stopped = true;
    run.abort.abort();
    if (run.usesMainConnection) {
        SillyTavern.getContext().stopGeneration?.();
    }
    pendingRuns.delete(id);
    renderHistory();
}

// ---------------------------------------------------------------------------
// Translation (uses the user's translation extension via its slash command)
// ---------------------------------------------------------------------------

async function translateText(text) {
    const ctx = SillyTavern.getContext();
    let template = String(getSettings().translateCommand || '').trim();
    if (!template.startsWith('/')) {
        throw new Error('번역 명령은 /로 시작해야 해요. 설정에서 번역 명령을 확인해 주세요.');
    }
    if (!template.includes('{{text}}')) template += ' {{text}}';
    // Pass the text through a variable so pipes or braces in it cannot break the command.
    ctx.variables.global.set(TRANSLATE_BUFFER_VAR, text);
    try {
        const command = template.replaceAll('{{text}}', `{{getglobalvar::${TRANSLATE_BUFFER_VAR}}}`);
        const result = await ctx.executeSlashCommandsWithOptions(command, {
            handleParserErrors: true,
            source: 'QR Panel translation',
        });
        if (result?.isError) throw new Error(result.errorMessage || '번역 명령 실행에 실패했어요.');
        return String(result?.pipe ?? '').trim();
    } finally {
        ctx.variables.global.del(TRANSLATE_BUFFER_VAR);
    }
}

async function translateEntry(id) {
    const chatId = getCurrentChatId();
    const entry = getChatState()?.history.find(e => e.id === id);
    if (!entry?.output) return;
    const card = document.querySelector(`.qrp-card[data-id="${id}"]`);
    card?.classList.add('qrp-translating');
    try {
        const translated = await translateText(entry.output);
        if (!translated) throw new Error('번역 결과가 비어 있어요. 번역 확장이 켜져 있는지 확인해 주세요.');
        if (getCurrentChatId() !== chatId) return;
        entry.translation = translated;
        showOriginal.delete(id);
        await saveChatState();
    } catch (err) {
        console.error(LOG_PREFIX, err);
        toastr.error(errorText(err), 'QR 패널 번역 실패');
    } finally {
        card?.classList.remove('qrp-translating');
        renderHistory();
    }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

async function generateSummary() {
    if (summaryBusy) return;
    const ctx = SillyTavern.getContext();
    const chatId = getCurrentChatId();
    const state = getChatState();
    if (!state) {
        toastr.warning('먼저 채팅을 열어 주세요.', 'QR 패널');
        return;
    }
    const s = getSettings();
    const log = formatRecentMessages(Number(s.summaryRange) || 60);
    if (!log) {
        toastr.info('요약할 대화가 없어요.', 'QR 패널');
        return;
    }
    const parts = [];
    if (s.includeCharInfo) {
        const info = getCharacterInfo();
        if (info) parts.push(`<character_info>\n${info}\n</character_info>`);
    }
    if (state.summary.trim()) parts.push(`<previous_summary>\n${state.summary.trim()}\n</previous_summary>`);
    parts.push(`<messages>\n${log}\n</messages>`);

    summaryBusy = true;
    renderSummary();
    try {
        const text = (await generateText({
            system: buildSystemPrompt(),
            user: buildUserPrompt(parts.join('\n\n'), ctx.substituteParams(s.summaryPrompt || DEFAULT_SUMMARY_PROMPT)),
            signal: null,
        })).trim();
        if (!text) throw new Error('AI가 빈 요약을 보냈어요.');
        if (getCurrentChatId() !== chatId) {
            toastr.warning('요약이 끝나기 전에 채팅이 바뀌어서 저장하지 못했어요.', 'QR 패널');
            return;
        }
        const current = getChatState();
        current.summary = text;
        current.summaryUpdatedAt = Date.now();
        await saveChatState();
        toastr.success('요약을 갱신했어요.', 'QR 패널');
    } catch (err) {
        console.error(LOG_PREFIX, err);
        toastr.error(errorText(err), 'QR 패널 요약 실패');
    } finally {
        summaryBusy = false;
        renderSummary();
    }
}

/** Imports the latest summary written by ST's built-in Summarize extension (stored in message.extra.memory). */
async function importBuiltinSummary() {
    const { chat } = SillyTavern.getContext();
    const state = getChatState();
    if (!state) return;
    const memory = [...(chat ?? [])].reverse().find(m => m?.extra?.memory)?.extra?.memory;
    if (!memory) {
        toastr.info('이 채팅에서 ST 요약(Summarize) 확장이 만든 요약을 찾지 못했어요.', 'QR 패널');
        return;
    }
    state.summary = String(memory);
    state.summaryUpdatedAt = Date.now();
    await saveChatState();
    renderSummary();
    toastr.success('ST 요약 확장의 요약을 가져왔어요.', 'QR 패널');
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

let markdownConverter = null;
function renderMarkdown(text) {
    const libs = SillyTavern.libs ?? {};
    const showdownLib = libs.showdown ?? globalThis.showdown;
    const purify = libs.DOMPurify ?? globalThis.DOMPurify;
    if (showdownLib && purify) {
        if (!markdownConverter) {
            markdownConverter = new showdownLib.Converter({ simpleLineBreaks: true, strikethrough: true, tables: true, openLinksInNewWindow: true });
        }
        return purify.sanitize(markdownConverter.makeHtml(String(text ?? '')));
    }
    return escapeHtml(text).replace(/\n/g, '<br>');
}

function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
    toastr.success('복사했어요.', 'QR 패널', { timeOut: 1500 });
}

function getChatTitle() {
    const ctx = SillyTavern.getContext();
    if (!getCurrentChatId()) return '채팅 없음';
    if (ctx.groupId) {
        return ctx.groups?.find(g => g.id === ctx.groupId)?.name ?? '그룹 채팅';
    }
    return ctx.name2 || '';
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function languageOptionsHtml() {
    return LANGUAGES.map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`).join('');
}

function buildPanel() {
    if (document.getElementById('qrp_panel')) return;
    const html = `
<div id="qrp_panel" class="qrp-panel" style="display:none" aria-label="QR 패널">
    <div class="qrp-header" title="끌어서 옮길 수 있어요">
        <i class="fa-solid fa-layer-group"></i>
        <span class="qrp-title">QR 패널</span>
        <span class="qrp-chatname"></span>
        <div class="qrp-header-buttons">
            <div class="qrp-icon-btn fa-solid fa-rotate" data-action="refresh" title="QR 목록 새로고침"></div>
            <div class="qrp-icon-btn fa-solid fa-gear" data-action="settings" title="설정 열기"></div>
            <div class="qrp-icon-btn fa-solid fa-xmark" data-action="close" title="닫기"></div>
        </div>
    </div>
    <div class="qrp-toolbar">
        <label title="패널에서 생성할 때 쓸 연결 프로필">
            <i class="fa-solid fa-plug"></i>
            <select class="text_pole qrp-profile-select"></select>
        </label>
        <label title="AI가 답할 언어">
            <i class="fa-solid fa-language"></i>
            <select class="text_pole qrp-lang-select">${languageOptionsHtml()}</select>
        </label>
        <input type="text" class="text_pole qrp-lang-custom" placeholder="예: Spanish">
    </div>
    <div class="qrp-qrbar"></div>
    <details class="qrp-summary">
        <summary><i class="fa-solid fa-book-open"></i> 요약 <span class="qrp-summary-meta"></span></summary>
        <textarea class="text_pole qrp-summary-text" rows="6" placeholder="이 채팅의 요약이에요. 직접 써도 되고 아래 버튼으로 만들 수도 있어요."></textarea>
        <div class="qrp-summary-buttons">
            <div class="menu_button qrp-summary-generate"><i class="fa-solid fa-wand-magic-sparkles"></i> AI로 요약 갱신</div>
            <div class="menu_button qrp-summary-import" title="ST 기본 요약(Summarize) 확장이 만든 최신 요약을 가져와요"><i class="fa-solid fa-file-import"></i> 요약 확장에서 가져오기</div>
        </div>
    </details>
    <div class="qrp-history"></div>
    <div class="qrp-footer">
        <span class="qrp-count"></span>
        <div class="qrp-link qrp-clear"><i class="fa-solid fa-trash-can"></i> 기록 비우기</div>
    </div>
</div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const panel = document.getElementById('qrp_panel');

    panel.querySelector('.qrp-header-buttons').addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'close') togglePanel(false);
        if (action === 'refresh') renderQrBar();
        if (action === 'settings') openSettingsDrawer();
    });

    panel.querySelector('.qrp-profile-select').addEventListener('change', (e) => setProfile(e.target.value));
    panel.querySelector('.qrp-lang-select').addEventListener('change', (e) => setLanguage(e.target.value));
    panel.querySelector('.qrp-lang-custom').addEventListener('input', (e) => setCustomLanguage(e.target.value));

    panel.querySelector('.qrp-qrbar').addEventListener('click', (e) => {
        const modeChip = e.target.closest('.qrp-mode');
        const btn = e.target.closest('.qrp-qr');
        if (!btn) return;
        const { set, label } = btn.dataset;
        if (modeChip) {
            e.stopPropagation();
            const next = cycleMode(set, label);
            modeChip.textContent = CONTEXT_MODES[next];
            modeChip.dataset.mode = next;
            return;
        }
        runQr(set, Number(btn.dataset.qrid), label);
    });

    const summaryText = panel.querySelector('.qrp-summary-text');
    summaryText.addEventListener('input', () => {
        const state = getChatState();
        if (!state) return;
        state.summary = summaryText.value;
        state.summaryUpdatedAt = Date.now();
        SillyTavern.getContext().saveMetadataDebounced?.();
        renderSummaryMeta();
    });
    panel.querySelector('.qrp-summary-generate').addEventListener('click', generateSummary);
    panel.querySelector('.qrp-summary-import').addEventListener('click', importBuiltinSummary);

    panel.querySelector('.qrp-history').addEventListener('click', onHistoryClick);
    panel.querySelector('.qrp-clear').addEventListener('click', clearHistory);

    setupDragAndResize(panel);
}

async function onHistoryClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.qrp-card');
    const id = card?.dataset.id;
    if (!id) return;
    const act = btn.dataset.act;

    if (act === 'stop') {
        stopRun(id);
        return;
    }
    const state = getChatState();
    const entry = state?.history.find(x => x.id === id);
    if (!entry) return;

    switch (act) {
        case 'translate':
            if (entry.translation) {
                if (showOriginal.has(id)) showOriginal.delete(id); else showOriginal.add(id);
                renderHistory();
            } else {
                await translateEntry(id);
            }
            break;
        case 'retranslate':
            entry.translation = null;
            await translateEntry(id);
            break;
        case 'copy': {
            const showingTranslation = entry.translation && !showOriginal.has(id);
            await copyToClipboard(showingTranslation ? entry.translation : (entry.output || entry.error || ''));
            break;
        }
        case 'rerun':
            await runQr(entry.set, entry.qrId, entry.label);
            break;
        case 'delete':
            state.history = state.history.filter(x => x.id !== id);
            showOriginal.delete(id);
            await saveChatState();
            renderHistory();
            break;
    }
}

async function clearHistory() {
    const ctx = SillyTavern.getContext();
    const state = getChatState();
    if (!state?.history.length) return;
    const ok = await ctx.Popup.show.confirm('기록 비우기', '이 채팅의 QR 패널 기록을 모두 지울까요? 요약은 지워지지 않아요.');
    if (ok !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
    state.history = [];
    showOriginal.clear();
    await saveChatState();
    renderHistory();
}

function renderQrBar() {
    const bar = document.querySelector('#qrp_panel .qrp-qrbar');
    if (!bar) return;
    if (!getQrApi()) {
        bar.innerHTML = '<div class="qrp-empty">Quick Reply 확장이 꺼져 있어요. 확장 프로그램 메뉴에서 Quick Reply를 켜 주세요.</div>';
        return;
    }
    const groups = getVisibleSets();
    if (!groups.length) {
        bar.innerHTML = '<div class="qrp-empty">표시할 QR이 없어요. Quick Reply 세트를 만들거나 설정에서 표시할 세트를 골라 주세요.</div>';
        return;
    }
    bar.innerHTML = groups.map(group => `
        <div class="qrp-set">
            <div class="qrp-set-name">${escapeHtml(group.name)}</div>
            <div class="qrp-set-buttons">
                ${group.qrs.map(qr => {
                    const mode = getMode(group.name, qr.label);
                    const icon = qr.icon ? `<i class="fa-solid ${escapeHtml(qr.icon)}"></i> ` : '';
                    const script = isScriptQr(qr) ? '<i class="fa-solid fa-code qrp-script-mark" title="스크립트 QR"></i>' : '';
                    const title = qr.title || String(qr.message ?? '').slice(0, 200);
                    return `<div class="qrp-qr menu_button" data-set="${escapeHtml(group.name)}" data-qrid="${qr.id}" data-label="${escapeHtml(qr.label)}" title="${escapeHtml(title)}">
                        <span class="qrp-qr-label">${icon}${escapeHtml(qr.label || '(이름 없음)')}${script}</span>
                        <span class="qrp-mode" data-mode="${mode}" title="눌러서 맥락 바꾸기">${CONTEXT_MODES[mode]}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>`).join('');
}

function cardHtml(entry, pending) {
    const tags = [
        `<span class="qrp-tag">${escapeHtml(entry.set)}</span>`,
        `<span class="qrp-tag" data-mode="${entry.mode}">${CONTEXT_MODES[entry.mode] ?? entry.mode}</span>`,
        entry.kind === 'script' ? '<span class="qrp-tag">스크립트</span>' : '',
        entry.profile ? `<span class="qrp-tag">${escapeHtml(entry.profile)}</span>` : '',
        entry.language ? `<span class="qrp-tag">${escapeHtml(entry.language)}</span>` : '',
    ].join('');

    if (pending) {
        return `<div class="qrp-card qrp-pending" data-id="${entry.id}">
            <div class="qrp-card-head"><b>${escapeHtml(entry.label)}</b>${tags}</div>
            <div class="qrp-card-body"><i class="fa-solid fa-spinner fa-spin"></i> 생성 중…</div>
            <div class="qrp-card-actions">${entry.kind === 'script' ? '' : '<div class="qrp-act" data-act="stop"><i class="fa-solid fa-stop"></i> 중지</div>'}</div>
        </div>`;
    }

    const hasTranslation = Boolean(entry.translation);
    const original = showOriginal.has(entry.id);
    let body;
    if (entry.error) {
        body = `<div class="qrp-error"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(entry.error)}</div>`;
    } else {
        body = renderMarkdown(hasTranslation && !original ? entry.translation : entry.output);
    }
    const translateLabel = hasTranslation ? (original ? '번역 보기' : '원문 보기') : '번역';
    return `<div class="qrp-card${entry.error ? ' qrp-failed' : ''}" data-id="${entry.id}">
        <div class="qrp-card-head"><b>${escapeHtml(entry.label)}</b>${tags}<span class="qrp-time">${formatTime(entry.at)}</span></div>
        <div class="qrp-card-body">${body}</div>
        <div class="qrp-card-actions">
            ${entry.output && !entry.error ? `<div class="qrp-act" data-act="translate"><i class="fa-solid fa-language"></i> ${translateLabel}</div>` : ''}
            ${hasTranslation ? '<div class="qrp-act" data-act="retranslate" title="다시 번역"><i class="fa-solid fa-arrows-rotate"></i></div>' : ''}
            <div class="qrp-act" data-act="copy" title="복사"><i class="fa-solid fa-copy"></i></div>
            <div class="qrp-act" data-act="rerun" title="다시 실행"><i class="fa-solid fa-play"></i></div>
            <div class="qrp-act" data-act="delete" title="삭제"><i class="fa-solid fa-trash-can"></i></div>
        </div>
    </div>`;
}

function renderHistory(scrollToBottom = false) {
    const list = document.querySelector('#qrp_panel .qrp-history');
    if (!list) return;
    const chatId = getCurrentChatId();
    const state = getChatState();
    const panel = document.getElementById('qrp_panel');
    panel.querySelector('.qrp-chatname').textContent = getChatTitle();

    if (!state) {
        list.innerHTML = '<div class="qrp-empty">채팅을 열면 이 채팅의 QR 패널 기록이 여기에 보여요.</div>';
        panel.querySelector('.qrp-count').textContent = '';
        return;
    }
    const pending = [...pendingRuns.values()].filter(r => r.chatId === chatId).map(r => r.entry);
    if (!state.history.length && !pending.length) {
        list.innerHTML = '<div class="qrp-empty">위의 QR 버튼을 누르면 결과가 이 채팅에만 저장돼요. 본 채팅에는 기록되지 않아요.</div>';
    } else {
        const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
        list.innerHTML = state.history.map(e => cardHtml(e, false)).join('') + pending.map(e => cardHtml(e, true)).join('');
        if (scrollToBottom || nearBottom) list.scrollTop = list.scrollHeight;
    }
    panel.querySelector('.qrp-count').textContent = `기록 ${state.history.length}개`;
}

function renderSummaryMeta() {
    const meta = document.querySelector('#qrp_panel .qrp-summary-meta');
    if (!meta) return;
    const state = getChatState();
    if (!state) {
        meta.textContent = '';
        return;
    }
    const len = state.summary.trim().length;
    meta.textContent = len ? `${len}자${state.summaryUpdatedAt ? ` · ${formatTime(state.summaryUpdatedAt)}` : ''}` : '비어 있음';
}

function renderSummary() {
    const panel = document.getElementById('qrp_panel');
    if (!panel) return;
    const state = getChatState();
    const ta = panel.querySelector('.qrp-summary-text');
    ta.value = state?.summary ?? '';
    ta.disabled = !state || summaryBusy;
    const gen = panel.querySelector('.qrp-summary-generate');
    gen.classList.toggle('disabled', summaryBusy || !state);
    gen.innerHTML = summaryBusy
        ? '<i class="fa-solid fa-spinner fa-spin"></i> 요약 중…'
        : '<i class="fa-solid fa-wand-magic-sparkles"></i> AI로 요약 갱신';
    renderSummaryMeta();
}

function renderAll() {
    if (!document.getElementById('qrp_panel')) return;
    renderQrBar();
    renderSummary();
    renderHistory(true);
    syncControls();
}

function isNarrowScreen() {
    return window.matchMedia('(max-width: 1000px)').matches;
}

function clampPanel(panel) {
    if (isNarrowScreen()) return;
    const s = getSettings();
    const width = Math.min(Math.max(300, s.panel.width || 440), window.innerWidth - 16);
    const height = Math.min(Math.max(300, s.panel.height || 620), window.innerHeight - 16);
    let left = s.panel.left ?? (window.innerWidth - width - 24);
    let top = s.panel.top ?? 70;
    left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    top = Math.min(Math.max(8, top), window.innerHeight - 60);
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
}

function setupDragAndResize(panel) {
    const header = panel.querySelector('.qrp-header');
    let drag = null;

    header.addEventListener('pointerdown', (e) => {
        if (isNarrowScreen() || e.target.closest('.qrp-icon-btn')) return;
        const rect = panel.getBoundingClientRect();
        drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const left = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - 80);
        const top = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - 40);
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    });
    const endDrag = () => {
        if (!drag) return;
        drag = null;
        const s = getSettings();
        s.panel.left = parseInt(panel.style.left, 10);
        s.panel.top = parseInt(panel.style.top, 10);
        saveSettings();
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);

    // CSS `resize: both` handles resizing; persist the size.
    let resizeTimer = null;
    new ResizeObserver(() => {
        if (isNarrowScreen() || panel.style.display === 'none') return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const s = getSettings();
            s.panel.width = Math.round(panel.offsetWidth);
            s.panel.height = Math.round(panel.offsetHeight);
            saveSettings();
        }, 300);
    }).observe(panel);

    window.addEventListener('resize', () => {
        if (panel.style.display !== 'none') clampPanel(panel);
    });
}

function togglePanel(force) {
    buildPanel();
    const panel = document.getElementById('qrp_panel');
    const open = typeof force === 'boolean' ? force : panel.style.display === 'none';
    panel.style.display = open ? 'flex' : 'none';
    const s = getSettings();
    s.panel.open = open;
    saveSettings();
    if (open) {
        clampPanel(panel);
        renderAll();
    }
}

function openSettingsDrawer() {
    const settingsBlock = document.getElementById('qrp_settings');
    const extensionsButton = document.querySelector('#extensions-settings-button .drawer-toggle');
    const extensionsDrawer = document.getElementById('rm_extensions_block');
    if (extensionsDrawer && !extensionsDrawer.classList.contains('openDrawer') && extensionsButton) {
        extensionsButton.click();
    }
    const content = settingsBlock?.querySelector('.inline-drawer-content');
    if (content && getComputedStyle(content).display === 'none') {
        settingsBlock.querySelector('.inline-drawer-toggle')?.click();
    }
    setTimeout(() => settingsBlock?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
}

// ---------------------------------------------------------------------------
// Shared controls (panel toolbar + settings drawer)
// ---------------------------------------------------------------------------

function setProfile(id) {
    getSettings().profileId = id;
    saveSettings();
    syncControls();
}

function setLanguage(value) {
    getSettings().outputLanguage = value;
    saveSettings();
    syncControls();
}

function setCustomLanguage(value) {
    getSettings().customLanguage = value;
    saveSettings();
    document.querySelectorAll('.qrp-lang-custom').forEach(el => {
        if (el.value !== value) el.value = value;
    });
}

function profileOptionsHtml() {
    const s = getSettings();
    const profiles = getProfiles();
    let html = '<option value="">현재 연결 사용</option>';
    html += profiles
        .slice()
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
        .join('');
    if (s.profileId && !profiles.some(p => p.id === s.profileId)) {
        html += `<option value="${escapeHtml(s.profileId)}">(찾을 수 없는 프로필)</option>`;
    }
    return html;
}

function syncControls() {
    const s = getSettings();
    const options = profileOptionsHtml();
    document.querySelectorAll('.qrp-profile-select').forEach(sel => {
        sel.innerHTML = options;
        sel.value = s.profileId;
    });
    document.querySelectorAll('.qrp-lang-select').forEach(sel => {
        sel.value = s.outputLanguage;
    });
    document.querySelectorAll('.qrp-lang-custom').forEach(el => {
        el.style.display = s.outputLanguage === '__custom' ? '' : 'none';
        if (el.value !== s.customLanguage) el.value = s.customLanguage;
    });
}

// ---------------------------------------------------------------------------
// Settings drawer
// ---------------------------------------------------------------------------

function buildSettingsUi() {
    if (document.getElementById('qrp_settings')) return;
    const html = `
<div id="qrp_settings" class="extension_settings qrp-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>QR 패널</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="menu_button qrp-open-btn"><i class="fa-solid fa-layer-group"></i> 패널 열기 / 닫기</div>

            <h4>생성</h4>
            <label>연결 프로필</label>
            <select class="text_pole qrp-profile-select"></select>
            <small>"현재 연결 사용"이면 지금 채팅에 쓰는 API로 생성해요. 다른 프로필을 고르면 본 채팅 연결은 바꾸지 않고 패널만 그 프로필로 생성해요.</small>
            <label for="qrp_max_tokens">최대 응답 길이 (토큰)</label>
            <input id="qrp_max_tokens" type="number" class="text_pole" min="16" max="32000" step="16">
            <label>출력 언어</label>
            <select class="text_pole qrp-lang-select">${languageOptionsHtml()}</select>
            <input type="text" class="text_pole qrp-lang-custom" placeholder="언어 이름을 영어로 (예: Spanish)">

            <h4>맥락</h4>
            <label for="qrp_default_mode">새 QR 버튼의 기본 맥락</label>
            <select id="qrp_default_mode" class="text_pole">
                ${MODE_ORDER.map(m => `<option value="${m}">${CONTEXT_MODES[m]}</option>`).join('')}
            </select>
            <small>버튼마다 아래쪽 작은 표시를 누르면 맥락을 바꿀 수 있어요.</small>
            <label for="qrp_recent_count">최근 대화로 넣을 메시지 수</label>
            <input id="qrp_recent_count" type="number" class="text_pole" min="1" max="500">
            <label for="qrp_summary_range">AI 요약에 쓸 최근 메시지 수</label>
            <input id="qrp_summary_range" type="number" class="text_pole" min="1" max="1000">
            <label class="checkbox_label"><input id="qrp_char_info" type="checkbox"> 캐릭터 설명, 성격, 시나리오, 페르소나 함께 보내기</label>

            <h4>QR 표시</h4>
            <label class="checkbox_label"><input id="qrp_show_hidden" type="checkbox"> 메인 QR 바에서 숨긴 QR도 패널에 표시</label>
            <label class="checkbox_label"><input id="qrp_all_sets" type="checkbox"> 모든 QR 세트 표시</label>
            <div class="qrp-set-list"></div>

            <h4>번역</h4>
            <label for="qrp_translate_cmd">번역 명령</label>
            <input id="qrp_translate_cmd" type="text" class="text_pole" placeholder="/translate {{text}}">
            <small>쓰고 계신 번역 확장의 슬래시 명령을 넣어 주세요. <code>{{text}}</code> 자리에 패널 결과가 들어가요. ST 기본 번역(Chat Translation)은 <code>/translate {{text}}</code>이고, 번역할 언어와 번역기는 그 확장의 설정을 그대로 따라가요.</small>
            <label class="checkbox_label"><input id="qrp_auto_translate" type="checkbox"> 결과가 나오면 자동으로 번역</label>

            <h4>기록</h4>
            <label for="qrp_max_history">채팅당 저장할 최대 기록 수</label>
            <input id="qrp_max_history" type="number" class="text_pole" min="1" max="2000">

            <h4>AI 지시문 (영어 권장)</h4>
            <label for="qrp_system_prompt">시스템 지시문</label>
            <textarea id="qrp_system_prompt" class="text_pole" rows="6"></textarea>
            <div class="menu_button qrp-reset" data-target="systemPrompt">기본값으로 되돌리기</div>
            <label for="qrp_summary_prompt">요약 지시문</label>
            <textarea id="qrp_summary_prompt" class="text_pole" rows="5"></textarea>
            <div class="menu_button qrp-reset" data-target="summaryPrompt">기본값으로 되돌리기</div>
        </div>
    </div>
</div>`;
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    container?.insertAdjacentHTML('beforeend', html);
    const root = document.getElementById('qrp_settings');
    if (!root) return;

    const s = getSettings();
    const bindNumber = (sel, key) => {
        const el = root.querySelector(sel);
        el.value = s[key];
        el.addEventListener('input', () => {
            const n = Number(el.value);
            if (Number.isFinite(n) && n > 0) {
                getSettings()[key] = Math.round(n);
                saveSettings();
            }
        });
    };
    const bindCheckbox = (sel, key, after) => {
        const el = root.querySelector(sel);
        el.checked = Boolean(s[key]);
        el.addEventListener('change', () => {
            getSettings()[key] = el.checked;
            saveSettings();
            after?.();
        });
    };
    const bindText = (sel, key) => {
        const el = root.querySelector(sel);
        el.value = s[key];
        el.addEventListener('input', () => {
            getSettings()[key] = el.value;
            saveSettings();
        });
    };

    root.querySelector('.qrp-open-btn').addEventListener('click', () => togglePanel());
    root.querySelector('.qrp-profile-select').addEventListener('change', (e) => setProfile(e.target.value));
    root.querySelector('.qrp-lang-select').addEventListener('change', (e) => setLanguage(e.target.value));
    root.querySelector('.qrp-lang-custom').addEventListener('input', (e) => setCustomLanguage(e.target.value));

    bindNumber('#qrp_max_tokens', 'maxTokens');
    bindNumber('#qrp_recent_count', 'recentCount');
    bindNumber('#qrp_summary_range', 'summaryRange');
    bindNumber('#qrp_max_history', 'maxHistory');
    bindCheckbox('#qrp_char_info', 'includeCharInfo');
    bindCheckbox('#qrp_show_hidden', 'showHidden', renderQrBar);
    bindCheckbox('#qrp_auto_translate', 'autoTranslate');
    bindText('#qrp_translate_cmd', 'translateCommand');
    bindText('#qrp_system_prompt', 'systemPrompt');
    bindText('#qrp_summary_prompt', 'summaryPrompt');

    const modeSel = root.querySelector('#qrp_default_mode');
    modeSel.value = s.defaultMode;
    modeSel.addEventListener('change', () => {
        getSettings().defaultMode = modeSel.value;
        saveSettings();
        renderQrBar();
    });

    const allSets = root.querySelector('#qrp_all_sets');
    allSets.checked = !Array.isArray(s.enabledSets);
    allSets.addEventListener('change', () => {
        const settings = getSettings();
        settings.enabledSets = allSets.checked ? null : (getQrApi()?.listSets() ?? []);
        saveSettings();
        renderSetList();
        renderQrBar();
    });
    root.querySelector('.qrp-set-list').addEventListener('change', (e) => {
        const box = e.target.closest('input[data-set]');
        if (!box) return;
        const settings = getSettings();
        const list = new Set(settings.enabledSets ?? []);
        if (box.checked) list.add(box.dataset.set); else list.delete(box.dataset.set);
        settings.enabledSets = [...list];
        saveSettings();
        renderQrBar();
    });

    root.querySelectorAll('.qrp-reset').forEach(btn => btn.addEventListener('click', () => {
        const key = btn.dataset.target;
        getSettings()[key] = defaultSettings[key];
        saveSettings();
        root.querySelector(key === 'systemPrompt' ? '#qrp_system_prompt' : '#qrp_summary_prompt').value = defaultSettings[key];
    }));

    // Refresh the set list whenever the drawer is opened, so new QR sets show up.
    root.querySelector('.inline-drawer-toggle').addEventListener('click', () => setTimeout(renderSetList, 50));
    renderSetList();
}

function renderSetList() {
    const box = document.querySelector('#qrp_settings .qrp-set-list');
    if (!box) return;
    const s = getSettings();
    if (!Array.isArray(s.enabledSets)) {
        box.innerHTML = '';
        box.style.display = 'none';
        return;
    }
    box.style.display = '';
    const names = getQrApi()?.listSets() ?? [];
    box.innerHTML = names.length
        ? names.map(n => `<label class="checkbox_label"><input type="checkbox" data-set="${escapeHtml(n)}" ${s.enabledSets.includes(n) ? 'checked' : ''}> ${escapeHtml(n)}</label>`).join('')
        : '<small>QR 세트가 없어요.</small>';
}

// ---------------------------------------------------------------------------
// Entry points: wand menu button and slash command
// ---------------------------------------------------------------------------

function addMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('qrp_menu_button')) return;
    menu.insertAdjacentHTML('beforeend', `
        <div id="qrp_menu_button" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="QR 패널 열기">
            <div class="fa-solid fa-layer-group extensionsMenuExtensionButton"></div>
            <span>QR 패널</span>
        </div>`);
    document.getElementById('qrp_menu_button').addEventListener('click', () => togglePanel());
}

function registerPanelCommand() {
    const ctx = SillyTavern.getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'qrpanel',
        callback: (_namedArgs, unnamedArgs) => {
            const action = String(unnamedArgs ?? '').trim().toLowerCase();
            if (action === 'open') togglePanel(true);
            else if (action === 'close') togglePanel(false);
            else togglePanel();
            return '';
        },
        returns: 'nothing',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'open, close, or toggle (default)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumList: ['open', 'close', 'toggle'],
            }),
        ],
        helpString: '<div>Opens or closes the QR Panel. Usage: <code>/qrpanel</code>, <code>/qrpanel open</code>, <code>/qrpanel close</code></div>',
    }));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

jQuery(() => {
    const ctx = SillyTavern.getContext();
    const { eventSource, eventTypes } = ctx;
    getSettings();

    buildSettingsUi();
    registerPanelCommand();

    eventSource.on(eventTypes.APP_READY, () => {
        addMenuButton();
        buildPanel();
        syncControls();
        if (getSettings().panel.open) togglePanel(true);
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        showOriginal.clear();
        renderAll();
    });

    for (const key of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_DELETED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_LOADED']) {
        if (eventTypes[key]) eventSource.on(eventTypes[key], () => syncControls());
    }

    console.log(LOG_PREFIX, 'Loaded');
});
