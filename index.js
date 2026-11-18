// Story Notes (이야기 노트)
// 지나간 대화를 구간마다 짧게 정리해 두고, 그 노트를 AI에게 대신 보내 긴 채팅에서도 흐름을 기억하게 한다.
// 노트는 채팅마다 따로(chat metadata) 저장된다.

import { extension_settings } from '../../../extensions.js';
import {
    chat,
    chat_metadata,
    eventSource,
    event_types,
    saveSettingsDebounced,
    saveMetadata,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    generateRaw,
} from '../../../../script.js';
import { hideChatMessageRange } from '../../../chats.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { oai_settings } from '../../../openai.js';

const ID = 'story_notes';
const LOG = '[Story Notes]';

// ───────── 기본 설정 ─────────

const TOPICS = [
    { key: 'plot', label: '줄거리', ask: '이 구간에서 일어난 일을 시간 순서대로. 단순 나열보다 누가 무엇을 왜 했는지가 보이게 쓰고, 관계를 바꿀 만한 작은 행동이나 말도 놓치지 않는다. 핵심 대사는 따옴표로 원문 그대로 남긴다', on: true },
    { key: 'place', label: '장소', ask: '장면이 벌어진 곳', on: true },
    { key: 'when', label: '날짜·시간', ask: '작중 날짜와 시각 (대화에서 알 수 있을 때만)', on: true },
    { key: 'bond', label: '관계', ask: '인물 사이의 관계나 거리감이 어떻게 달라졌는지', on: true },
    { key: 'cast', label: '새 인물', ask: '새로 나온 인물의 이름과 특징', on: true },
    { key: 'mood', label: '감정', ask: '주요 인물의 감정 상태와 그 이유', on: false },
    { key: 'hooks', label: '남은 떡밥', ask: '아직 풀리지 않은 일, 약속, 복선', on: false },
];

// 처음 설치했을 때의 값 = 여름님 가이드의 추천 세팅을 이 확장에 맞춘 것
const DEFAULTS = {
    inject: true,
    auto: true,
    every: 20,        // 정리 안 된 메시지가 이만큼 쌓이면 자동 정리
    chunk: 5,         // 노트 하나에 묶을 메시지 수
    keepRecent: 20,   // 정리하지 않고 남길 최근 메시지
    hideDone: true,
    maxTokens: 30000,
    where: 'chat',    // chat | top | main
    depth: 21,        // 남겨 둔 최근 메시지 20개 바로 위
    lang: 'ko',
    prevAll: true,    // 새 노트를 쓸 때 앞 노트를 전부 참고
    profile: '',      // 정리에 쓸 연결 프로필 id ('' = 지금 채팅에 연결된 API)
    replyTokens: 8192, // 정리 답의 최대 길이 (생각하는 모델은 생각에도 이 몫을 씀)
    topics: Object.fromEntries(TOPICS.map(t => [t.key, t.on])),
};

function cfg() {
    if (!extension_settings[ID]) extension_settings[ID] = {};
    const s = extension_settings[ID];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    for (const t of TOPICS) {
        if (s.topics[t.key] === undefined) s.topics[t.key] = t.on;
    }
    return s;
}

// ───────── 채팅별 노트 저장 ─────────

function book() {
    if (!chat_metadata[ID] || !Array.isArray(chat_metadata[ID].notes)) {
        chat_metadata[ID] = { notes: [] };
    }
    return chat_metadata[ID];
}

/** 마지막으로 정리된 메시지 번호 (없으면 -1) */
function lastDone() {
    const notes = book().notes;
    return notes.length ? Math.max(...notes.map(n => n.to)) : -1;
}

/** 아직 정리하지 않은 구간 [from, to]. to는 최근 메시지 몇 개를 남긴 끝 번호. */
function waiting() {
    const s = cfg();
    const from = lastDone() + 1;
    const to = chat.length - 1 - Math.max(0, Number(s.keepRecent) || 0);
    return { from, to, count: Math.max(0, to - from + 1) };
}

/** 채팅이 지워져서 범위를 벗어난 노트는 버린다. */
function dropBrokenNotes() {
    const b = book();
    const before = b.notes.length;
    b.notes = b.notes.filter(n => n.to < chat.length);
    return before !== b.notes.length;
}

// ───────── AI에게 노트 보내기 ─────────

const PLACE = {
    chat: extension_prompt_types.IN_CHAT,
    top: extension_prompt_types.BEFORE_PROMPT,
    main: extension_prompt_types.IN_PROMPT,
};

async function buildInjection() {
    const s = cfg();
    const notes = [...book().notes].sort((a, b) => a.from - b.from);
    if (!s.inject || notes.length === 0) return { text: '', tokens: 0, used: 0 };

    const head = s.lang === 'en'
        ? '[Story so far — notes on earlier parts of this roleplay, oldest first]'
        : '[지금까지의 이야기 — 앞부분 대화를 정리한 노트, 오래된 순]';
    const budget = Math.max(100, Number(s.maxTokens) || DEFAULTS.maxTokens);

    // 최근 노트부터 한도 안에서 고른다.
    const picked = [];
    let total = await getTokenCountAsync(head);
    for (let i = notes.length - 1; i >= 0; i--) {
        const part = `\n\n(#${notes[i].from}~#${notes[i].to})\n${notes[i].text.trim()}`;
        const t = await getTokenCountAsync(part);
        if (total + t > budget && picked.length) break;
        picked.unshift(part);
        total += t;
    }
    return { text: head + picked.join(''), tokens: total, used: picked.length };
}

async function refreshInjection() {
    const s = cfg();
    const { text, tokens, used } = await buildInjection();
    setExtensionPrompt(ID, text, PLACE[s.where] ?? PLACE.chat, Number(s.depth) || 0, false, extension_prompt_roles.SYSTEM);
    updateStatus(tokens, used);
}

// ───────── 정리(요약) 만들기 ─────────

let busy = false;

function cleanText(str) {
    return String(str ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function buildRequest(from, to) {
    const s = cfg();
    const topics = TOPICS.filter(t => s.topics[t.key]);
    if (!topics.length) topics.push(TOPICS[0]);
    const langLine = s.lang === 'en' ? 'Write the notes in English.' : '노트는 한국어로 쓴다.';

    const lines = [];
    for (let i = from; i <= to; i++) {
        const m = chat[i];
        if (!m || (m.is_system && !m.extra?.[ID])) continue; // 원래 숨겨 둔 메시지는 건너뛴다
        const body = cleanText(m.mes);
        if (body) lines.push(`${m.name}: ${body}`);
    }

    const sorted = [...book().notes].sort((a, b) => a.from - b.from);
    const recent = s.prevAll ? sorted : sorted.slice(-2);
    const prev = recent.length ? recent.map(n => n.text.trim()).join('\n---\n') : '(없음)';

    const system = '너는 롤플레이 기록을 정리하는 기록 담당이다. 요청한 형식의 노트만 출력하고, 인사말이나 설명은 붙이지 않는다.';
    const user = [
        `아래는 롤플레이 대화 중 메시지 #${from}부터 #${to}까지다. 이 부분만 다음 항목으로 정리해라.`,
        langLine,
        '각 항목은 "항목명: 내용" 형식으로 쓰고, 대화에 실제로 나온 내용만 적는다. 해당 내용이 없으면 그 항목은 빼도 된다.',
        '',
        '[항목]',
        ...topics.map(t => `- ${t.label}: ${t.ask}`),
        '',
        '[앞 노트 — 흐름 참고용, 다시 쓰지 말 것]',
        prev,
        '',
        '[정리할 대화]',
        lines.join('\n\n'),
    ].join('\n');

    return { system, user, empty: lines.length === 0 };
}

/** 고른 연결 프로필 (없거나 지워졌으면 null = 지금 연결) */
function chosenProfile() {
    const id = cfg().profile;
    if (!id) return null;
    try {
        return ConnectionManagerRequestService.getSupportedProfiles().find(p => p.id === id) ?? null;
    } catch {
        return null;
    }
}

/** 정리 요청. 프로필을 골랐으면 그 연결로, 아니면 지금 채팅 연결로 보낸다. */
async function askAI(system, user) {
    const s = cfg();
    if (s.profile && !chosenProfile()) {
        toastr.warning('정리에 쓸 연결 프로필을 찾을 수 없어서 지금 연결로 정리해요.', '이야기 노트');
    }
    const profile = chosenProfile();
    if (!profile) {
        return await generateRaw({ prompt: user, systemPrompt: system });
    }
    // Vertex 인증 방식·프로젝트는 프로필에 저장되지 않으므로 지금 설정에서 가져온다.
    const extra = profile.api === 'vertexai' ? {
        vertexai_auth_mode: oai_settings.vertexai_auth_mode,
        vertexai_express_project_id: oai_settings.vertexai_express_project_id,
    } : {};
    const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
    const res = await ConnectionManagerRequestService.sendRequest(
        profile.id, messages, Number(s.replyTokens) || DEFAULTS.replyTokens,
        { stream: false, extractData: true, includePreset: true }, extra,
    );
    return typeof res === 'string' ? res : (res?.content ?? '');
}

async function writeNote(from, to) {
    const { system, user, empty } = buildRequest(from, to);
    if (empty) {
        book().notes.push({ from, to, text: '(내용 없음)' });
        return true;
    }
    const out = await askAI(system, user);
    const text = cleanText(out);
    if (!text) throw new Error('AI가 빈 답을 보냈어요.');
    book().notes.push({ from, to, text });
    if (cfg().hideDone) await setHidden(from, to, true);
    return true;
}

/** 우리가 숨긴 메시지에는 표시를 남겨, 나중에 되돌릴 때 원래 숨김과 구분한다. */
async function setHidden(from, to, hide) {
    for (let i = from; i <= to && i < chat.length; i++) {
        const m = chat[i];
        if (!m) continue;
        if (hide && !m.is_system) {
            m.extra = m.extra || {};
            m.extra[ID] = true;
            await hideChatMessageRange(i, i, false);
        } else if (!hide && m.extra?.[ID]) {
            delete m.extra[ID];
            await hideChatMessageRange(i, i, true);
        }
    }
}

/**
 * 기다리는 메시지를 정리한다.
 * @param {boolean} force true면 개수가 모자라도 남은 것을 전부 정리한다.
 */
async function runNotes(force = false) {
    if (busy) return;
    const s = cfg();
    const trigger = Math.max(1, Number(s.every) || DEFAULTS.every);
    const size = Math.max(1, Number(s.chunk) || DEFAULTS.chunk);
    let w = waiting();
    if (w.count === 0 || (!force && w.count < trigger)) return;

    busy = true;
    setBusy(true);
    let made = 0;
    try {
        // 한번 시작하면 기다리던 메시지를 노트 크기만큼씩 끝까지 정리한다.
        for (let guard = 0; guard < 200; guard++) {
            w = waiting();
            if (w.count === 0) break;
            const to = Math.min(w.to, w.from + size - 1);
            await writeNote(w.from, to);
            made++;
            await saveMetadata();
            await refreshInjection();
        }
        if (made) toastr.success(`노트 ${made}개를 새로 정리했어요.`, '이야기 노트');
    } catch (err) {
        console.error(LOG, err);
        toastr.error(String(err?.message || err), '이야기 노트 정리 실패');
    } finally {
        busy = false;
        setBusy(false);
        await refreshInjection();
    }
}

// ───────── 노트 보기 창 ─────────

async function openNotebook() {
    const wrap = $('<div class="sn-book"></div>');
    const render = () => {
        wrap.empty();
        wrap.append('<h3 class="sn-book-title"><i class="fa-solid fa-book-bookmark"></i> 이야기 노트</h3>');
        const notes = [...book().notes].sort((a, b) => a.from - b.from);
        if (!notes.length) {
            wrap.append('<p class="sn-empty">아직 정리된 노트가 없어요.</p>');
            return;
        }
        for (const n of notes) {
            const card = $(`
                <div class="sn-note">
                    <div class="sn-note-head">
                        <span class="sn-range">#${n.from} ~ #${n.to}</span>
                        <button type="button" class="menu_button sn-del" title="이 노트 지우고 메시지 다시 보이기"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                    <textarea class="text_pole sn-text" rows="5"></textarea>
                </div>`);
            card.find('.sn-text').val(n.text).on('input', async function () {
                n.text = String($(this).val());
                await saveMetadata();
                await refreshInjection();
            });
            card.find('.sn-del').on('click', async () => {
                book().notes = book().notes.filter(x => x !== n);
                await setHidden(n.from, n.to, false);
                await saveMetadata();
                await refreshInjection();
                render();
            });
            wrap.append(card);
        }
    };
    render();
    await callGenericPopup(wrap, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: '닫기', allowVerticalScrolling: true });
}

async function resetAll() {
    const ok = await callGenericPopup('이 채팅의 노트를 전부 지우고, 노트 때문에 숨겼던 메시지를 다시 보이게 할까요?', POPUP_TYPE.CONFIRM);
    if (!ok) return;
    for (const n of book().notes) await setHidden(n.from, n.to, false);
    book().notes = [];
    await saveMetadata();
    await refreshInjection();
    toastr.info('노트를 모두 지웠어요.', '이야기 노트');
}

// ───────── 설정 화면 ─────────

function addSettings() {
    const s = cfg();
    const topicBoxes = TOPICS.map(t => `
        <label class="checkbox_label sn-topic">
            <input type="checkbox" data-topic="${t.key}"> <span>${t.label}</span>
        </label>`).join('');

    const box = $(`
        <div class="sn-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Story Notes (이야기 노트)</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="sn-status" id="sn_status">불러오는 중…</div>
                    <div class="sn-buttons">
                        <div class="menu_button" id="sn_now"><i class="fa-solid fa-feather-pointed"></i> 지금 정리하기</div>
                        <div class="menu_button" id="sn_open"><i class="fa-solid fa-book-open"></i> 노트 보기</div>
                    </div>

                    <h4 class="sn-h">언제 정리할까</h4>
                    <label class="checkbox_label"><input type="checkbox" id="sn_auto"> <span>자동으로 정리하기</span></label>
                    <div class="sn-row"><label for="sn_every">안 정리된 메시지가 몇 개 쌓이면</label><input id="sn_every" class="text_pole" type="number" min="1" max="200"></div>
                    <div class="sn-row"><label for="sn_chunk">노트 하나에 묶을 메시지 수</label><input id="sn_chunk" class="text_pole" type="number" min="1" max="100"></div>
                    <div class="sn-row"><label for="sn_keep">정리 안 하고 남길 최근 메시지</label><input id="sn_keep" class="text_pole" type="number" min="0" max="200"></div>
                    <label class="checkbox_label"><input type="checkbox" id="sn_hide"> <span>정리가 끝난 메시지는 AI에게 안 보내기(숨김)</span></label>

                    <h4 class="sn-h">어떤 AI로 정리할까</h4>
                    <div class="sn-row"><label for="sn_profile">정리에 쓸 연결</label>
                        <select id="sn_profile" class="text_pole"></select></div>
                    <small class="sn-hint">채팅과 다른 모델로 정리할 수 있어요. 고를 수 있는 건 연결 프로필에 저장해 둔 연결이에요.</small>

                    <h4 class="sn-h">무엇을 적을까</h4>
                    <div class="sn-topics">${topicBoxes}</div>
                    <div class="sn-row"><label for="sn_lang">노트 언어</label>
                        <select id="sn_lang" class="text_pole"><option value="ko">한국어</option><option value="en">영어 (토큰 절약)</option></select></div>
                    <label class="checkbox_label"><input type="checkbox" id="sn_prevall"> <span>새 노트를 쓸 때 앞 노트를 전부 참고 (흐름이 덜 끊겨요)</span></label>

                    <h4 class="sn-h">AI에게 어떻게 보낼까</h4>
                    <label class="checkbox_label"><input type="checkbox" id="sn_inject"> <span>노트를 AI에게 보내기</span></label>
                    <div class="sn-row"><label for="sn_max">노트 최대 분량(토큰)</label><input id="sn_max" class="text_pole" type="number" min="100" max="20000" step="100"></div>
                    <div class="sn-row"><label for="sn_where">넣을 자리</label>
                        <select id="sn_where" class="text_pole">
                            <option value="chat">대화 사이 (깊이 지정)</option>
                            <option value="main">메인 프롬프트 뒤</option>
                            <option value="top">맨 앞</option>
                        </select></div>
                    <div class="sn-row"><label for="sn_depth">깊이</label><input id="sn_depth" class="text_pole" type="number" min="0" max="100"></div>

                    <div class="sn-buttons sn-danger-zone">
                        <div class="menu_button" id="sn_defaults"><i class="fa-solid fa-rotate-left"></i> 추천 설정으로 되돌리기</div>
                        <div class="menu_button" id="sn_reset"><i class="fa-solid fa-broom"></i> 이 채팅 노트 전부 지우기</div>
                    </div>
                </div>
            </div>
        </div>`);

    const bindCheck = (sel, key) => box.find(sel).prop('checked', !!s[key]).on('change', function () {
        cfg()[key] = this.checked; changed();
    });
    const bindNum = (sel, key) => box.find(sel).val(s[key]).on('input', function () {
        cfg()[key] = Number($(this).val()) || 0; changed();
    });
    const bindSel = (sel, key) => box.find(sel).val(s[key]).on('change', function () {
        cfg()[key] = String($(this).val()); changed();
    });

    bindCheck('#sn_auto', 'auto');
    bindCheck('#sn_hide', 'hideDone');
    bindCheck('#sn_inject', 'inject');
    bindCheck('#sn_prevall', 'prevAll');
    bindNum('#sn_every', 'every');
    bindNum('#sn_chunk', 'chunk');
    bindNum('#sn_keep', 'keepRecent');
    bindNum('#sn_max', 'maxTokens');
    bindNum('#sn_depth', 'depth');
    bindSel('#sn_lang', 'lang');
    bindSel('#sn_where', 'where');
    const fillProfiles = () => {
        const sel = box.find('#sn_profile').empty();
        sel.append($('<option value=""></option>').text('지금 채팅에 연결된 API'));
        let list = [];
        try { list = ConnectionManagerRequestService.getSupportedProfiles(); } catch { /* 연결 관리자 꺼짐 */ }
        for (const p of list) sel.append($('<option></option>').val(p.id).text(p.name));
        const cur = cfg().profile;
        if (cur && !list.some(p => p.id === cur)) {
            sel.append($('<option></option>').val(cur).text('(지워진 프로필 — 지금 연결로 정리)'));
        }
        sel.val(cur);
    };
    fillProfiles();
    // 설정을 펼칠 때 목록을 새로 채운다 (드롭다운을 여는 순간 비우면 모바일에서 닫혀 버림)
    box.find('.inline-drawer-toggle').on('click', fillProfiles);
    box.find('#sn_profile').on('change', function () {
        cfg().profile = String($(this).val()); changed();
    });
    box.find('[data-topic]').each(function () {
        const key = this.dataset.topic;
        $(this).prop('checked', !!s.topics[key]).on('change', function () {
            cfg().topics[key] = this.checked; changed();
        });
    });

    box.find('#sn_now').on('click', () => runNotes(true));
    box.find('#sn_open').on('click', openNotebook);
    box.find('#sn_reset').on('click', resetAll);
    box.find('#sn_defaults').on('click', () => {
        const keepProfile = cfg().profile;
        extension_settings[ID] = structuredClone(DEFAULTS);
        extension_settings[ID].profile = keepProfile;
        const d = cfg();
        box.find('#sn_auto').prop('checked', d.auto);
        box.find('#sn_hide').prop('checked', d.hideDone);
        box.find('#sn_inject').prop('checked', d.inject);
        box.find('#sn_prevall').prop('checked', d.prevAll);
        box.find('#sn_every').val(d.every);
        box.find('#sn_chunk').val(d.chunk);
        box.find('#sn_keep').val(d.keepRecent);
        box.find('#sn_max').val(d.maxTokens);
        box.find('#sn_depth').val(d.depth);
        box.find('#sn_lang').val(d.lang);
        box.find('#sn_where').val(d.where);
        box.find('[data-topic]').each(function () { $(this).prop('checked', !!d.topics[this.dataset.topic]); });
        changed();
        toastr.info('추천 설정으로 되돌렸어요.', '이야기 노트');
    });

    $('#extensions_settings2').append(box);
}

function changed() {
    saveSettingsDebounced();
    refreshInjection();
}

function setBusy(on) {
    $('#sn_now').toggleClass('disabled', on).find('i').toggleClass('fa-spin', on);
    if (on) $('#sn_status').text('정리하는 중이에요…');
}

function updateStatus(tokens, used) {
    if (busy) return;
    const notes = book().notes;
    const w = waiting();
    const done = notes.length ? `#0~#${lastDone()}` : '없음';
    $('#sn_status').html(
        `정리된 노트 <b>${notes.length}</b>개 (메시지 ${done})<br>`
        + `정리 기다리는 메시지 <b>${w.count}</b>개<br>`
        + `AI에게 보내는 노트 <b>${used}</b>개 · 약 <b>${tokens}</b>토큰`,
    );
}

// ───────── 마술봉 메뉴 ─────────

function addMenuItem() {
    const item = $(`
        <div id="sn_menu_item" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
            <div class="fa-solid fa-book-bookmark extensionsMenuExtensionButton"></div>
            <span>이야기 노트</span>
        </div>`);
    item.on('click', openNotebook);
    $('#extensionsMenu').append(item);
}

// ───────── 시작 ─────────

jQuery(() => {
    cfg();
    addSettings();
    addMenuItem();

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        if (dropBrokenNotes()) await saveMetadata();
        await refreshInjection();
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        if (!cfg().auto) return refreshInjection();
        setTimeout(() => runNotes(false), 300);
    });
    eventSource.on(event_types.MESSAGE_DELETED, async () => {
        if (dropBrokenNotes()) await saveMetadata();
        await refreshInjection();
    });

    refreshInjection();
});
