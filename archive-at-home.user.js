// ==UserScript==
// @name         A@H 下载助手
// @description  从 archive-at-home.org 获取 E-Hentai 归档下载链接
// @namespace    https://github.com/Archive-At-Home
// @version      0.2.0
// @author       https://github.com/taskmgr818
// @homepageURL  https://github.com/Archive-At-Home/archive-at-home.user.js
// @supportURL   https://github.com/Archive-At-Home/archive-at-home.user.js/issues
// @updateURL    https://raw.githubusercontent.com/Archive-At-Home/archive-at-home.user.js/main/archive-at-home.user.js
// @downloadURL  https://raw.githubusercontent.com/Archive-At-Home/archive-at-home.user.js/main/archive-at-home.user.js
// @match        *://e-hentai.org/g/*
// @match        *://exhentai.org/g/*
// @match        *://api.archive-at-home.org/auth/telegram/login
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      api.archive-at-home.org
// ==/UserScript==

(function () {
    'use strict';

    const AUTH_URL = 'https://api.archive-at-home.org/auth/telegram/login';
    const API_BASE = 'https://api.archive-at-home.org';
    const STORAGE_KEY = 'A@H_API_KEY';
    const STORAGE_AUTO_DOWNLOAD = 'A@H_AUTO_DOWNLOAD';
    const STORAGE_PANEL_COLLAPSED = 'A@H_PANEL_COLLAPSED';
    const PANEL_ID = 'ah-auth-panel';
    const PANEL_STYLE_ID = 'ah-auth-panel-style';
    let panel;
    let isPanelCollapsed = false;

    init();

    function init() {
        ensurePanelStyle();
        panel = getOrCreatePanel();
        isPanelCollapsed = !!GM_getValue(STORAGE_PANEL_COLLAPSED, false);
        applyPanelCollapsedState();
        (window.location.hostname === 'api.archive-at-home.org' ? startAuthFlow : startAppFlow)();
    }

    function startAuthFlow() {
        showStatus('正在等待 Telegram 登录...', false);
        const timer = setInterval(() => {
            const key = getCurrentApiKey();
            if (!key) {
                return;
            }

            GM_setValue(STORAGE_KEY, key);
            clearInterval(timer);
            showStatus('登录成功，窗口即将关闭。', true);
            setTimeout(() => window.close(), 300);
        }, 500);
    }

    function startAppFlow() {
        renderApp(GM_getValue(STORAGE_KEY));

        GM_addValueChangeListener(STORAGE_KEY, (_, oldValue, newValue) => {
            if (oldValue !== newValue) {
                renderApp(newValue);
            }
        });
    }

    function renderApp(key) {
        panel.className = isPanelCollapsed ? 'ah-panel ah-collapsed' : 'ah-panel';
        panel.innerHTML = '';

        const body = el('div', { className: 'ah-body' });

        if (!key) {
            panel.append(
                createHeader('A@H 下载助手', '账号未登录，请先登录。'),
                body,
            );

            body.append(button('使用 Telegram 登录', 'primary', () => window.open(AUTH_URL, '_blank')));
            return;
        }

        const gallery = extractGalleryInfo();
        const profileContent = el('div', { className: 'ah-info', text: '正在加载资料...' });
        const parseMessage = messageBox();
        const autoDownload = el('input', {
            type: 'checkbox',
            checked: !!GM_getValue(STORAGE_AUTO_DOWNLOAD, false),
        });

        const profileSection = section('用户信息');
        const parseSection = section('解析画廊');
        const runParse = (force) => parseGallery(
            key,
            gallery,
            parseMessage,
            profileContent,
            force,
            autoDownload.checked,
        );

        profileSection.append(
            profileContent,
            el('div', { className: 'ah-row' },
                button('刷新资料', 'secondary', () => loadProfile(key, profileContent)),
            ),
        );

        parseSection.append(
            el('label', { className: 'ah-toggle' },
                autoDownload,
                el('span', { text: '解析成功后直接下载' }),
            ),
            el('div', { className: 'ah-row' },
                button('解析下载链接', 'primary', () => runParse(false)),
                button('强制重试', 'secondary', () => runParse(true)),
            ),
            parseMessage,
        );

        autoDownload.addEventListener('change', () => {
            GM_setValue(STORAGE_AUTO_DOWNLOAD, !!autoDownload.checked);
        });

        panel.append(createHeader('A@H 下载助手', '已连接到 archive-at-home.org'), body);
        body.append(profileSection, parseSection);

        loadProfile(key, profileContent);
    }

    async function loadProfile(key, container) {
        // 使用占位符保持高度稳定，防止页面跳跃
        container.replaceChildren(el('div', { className: 'ah-loading-placeholder' }));

        try {
            const data = await apiRequest(key, 'GET', '/api/v1/me');
            container.replaceChildren(
                infoRow('ID', data.user.id),
                infoRow('昵称', data.user.nickname || '-'),
                infoRow('余额', `${data.balance} GP`),
            );
        } catch (error) {
            container.replaceChildren();
            container.textContent = error.message || '获取资料失败';
        }
    }

    async function parseGallery(key, gallery, box, profileContainer, force, autoDownload) {
        const galleryId = gallery.galleryId?.trim() || '';
        const galleryKey = gallery.galleryKey?.trim() || '';
        if (!galleryId || !galleryKey) {
            setMessage(box, '当前页面未识别到画廊 ID/Key，请确认在画廊详情页使用。', 'error');
            return;
        }

        setMessage(box, force ? '正在强制重新解析...' : '正在解析下载链接...', 'info');

        try {
            const data = await apiRequest(key, 'POST', '/api/v1/parse', {
                gallery_id: galleryId,
                gallery_key: galleryKey,
                force,
            }, {
                'X-Client': 'tampermonkey/aah-download-helper',
            });

            renderParseResult(box, data);
            await loadProfile(key, profileContainer);
            if (autoDownload && data.archive_url) {
                window.location.assign(data.archive_url);
            }
        } catch (error) {
            setMessage(box, error.message || '解析失败', 'error');
        }
    }

    function apiRequest(key, method, path, body, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url: `${API_BASE}${path}`,
                responseType: 'json',
                headers: {
                    'Content-Type': 'application/json',
                    ...(key?.trim() && { Authorization: `Bearer ${key.trim()}` }),
                    ...extraHeaders,
                },
                data: body ? JSON.stringify(body) : undefined,
                onload: (response) => {
                    const data = response.response || {};
                    if (!(response.status >= 200 && response.status < 300)) {
                        reject(new Error(data.error || data.message || `请求失败 (${response.status})`));
                        return;
                    }

                    resolve(data);
                },
                onerror: () => reject(new Error('网络请求失败')),
                ontimeout: () => reject(new Error('请求超时')),
            });
        });
    }

    function renderParseResult(container, data) {
        container.innerHTML = '';
        if (!data.archive_url) {
            setMessage(container, data.error || '解析失败', 'error');
            return;
        }

        const copyBtn = el('button', {
            type: 'button',
            className: 'ah-copy-button',
            text: '复制下载链接',
        });

        copyBtn.addEventListener('click', () => {
            let copied = false;
            if (typeof GM_setClipboard === 'function') {
                try {
                    GM_setClipboard(data.archive_url, 'text');
                    copied = true;
                } catch (error) {
                    console.warn('GM_setClipboard 复制失败:', error);
                }
            }

            copyBtn.textContent = copied ? '已复制' : '复制失败';
            setTimeout(() => {
                copyBtn.textContent = '复制下载链接';
            }, 1200);
        });

        const resultDiv = el('div');
        resultDiv.append(
            el('div', { text: data.cached ? '缓存命中' : '新解析完成' }),
            el('div', { text: data.gp_cost ? `消耗: ${data.gp_cost} GP` : '未消耗额外 GP' }),
        );

        const wrapper = el('div', { className: 'ah-message ah-success' },
            resultDiv,
            copyBtn,
        );

        container.appendChild(wrapper);
    }

    function showStatus(text, isSuccess) {
        panel.className = isPanelCollapsed ? 'ah-panel ah-collapsed' : 'ah-panel';
        panel.innerHTML = '';
        const body = el('div', { className: 'ah-body' });
        const msg = messageBox();
        setMessage(msg, text, isSuccess ? 'success' : 'info');
        body.appendChild(msg);
        panel.append(createHeader('A@H 下载助手', ''), body);
    }

    function getCurrentApiKey() {
        return unsafeWindow.currentApiKey ?? window.currentApiKey;
    }

    function extractGalleryInfo() {
        const match = window.location.pathname.match(/\/g\/(\d+)\/([\w]+)/);
        return match ? { galleryId: match[1], galleryKey: match[2] } : { galleryId: '', galleryKey: '' };
    }

    function createHeader(title, subtitle) {
        const collapseButton = el('button', {
            type: 'button',
            className: 'ah-collapse-toggle',
            text: isPanelCollapsed ? '展开' : '收起',
        });
        collapseButton.addEventListener('click', togglePanelCollapsed);

        return el('div', { className: 'ah-header' },
            el('div', { className: 'ah-header-row' },
                el('div', { className: 'ah-title', text: title }),
                collapseButton,
            ),
            el('div', { className: 'ah-subtitle', text: subtitle }),
        );
    }

    function togglePanelCollapsed() {
        isPanelCollapsed = !isPanelCollapsed;
        GM_setValue(STORAGE_PANEL_COLLAPSED, isPanelCollapsed);
        applyPanelCollapsedState();
    }

    function applyPanelCollapsedState() {
        if (!panel) {
            return;
        }

        panel.classList.toggle('ah-collapsed', isPanelCollapsed);
        panel.querySelectorAll('.ah-collapse-toggle').forEach((buttonNode) => {
            buttonNode.textContent = isPanelCollapsed ? '展开' : '收起';
        });
    }

    function section(title) {
        return el('section', { className: 'ah-section' },
            el('div', { className: 'ah-section-title', text: title }),
        );
    }

    function button(text, variant, onClick) {
        const node = el('button', {
            type: 'button',
            className: `ah-button ah-button-${variant}`,
            text,
        });
        if (onClick) {
            node.addEventListener('click', onClick);
        }

        return node;
    }

    function messageBox() {
        return el('div', { className: 'ah-message' });
    }

    function setMessage(box, text, type) {
        box.textContent = text ?? '';
        box.className = type ? `ah-message ah-${type}` : 'ah-message';
    }

    function infoRow(label, value) {
        return el('div', { className: 'ah-info-row' },
            el('span', { className: 'ah-info-label', text: label }),
            el('span', { className: 'ah-info-value', text: value }),
        );
    }

    function el(tag, { text, ...props } = {}, ...children) {
        const node = document.createElement(tag);

        if (text !== undefined) {
            node.textContent = text;
        }

        for (const [key, value] of Object.entries(props)) {
            if (value !== undefined && value !== null && key in node) {
                node[key] = value;
            }
        }

        for (const child of children) {
            if (child !== null && child !== undefined) {
                node.appendChild(child);
            }
        }

        return node;
    }

    function ensurePanelStyle() {
        if (document.getElementById(PANEL_STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = PANEL_STYLE_ID;
        style.textContent = `
            #${PANEL_ID}.ah-panel {
                position: fixed;
                top: 16px;
                right: 16px;
                z-index: 9999;
                width: 320px;
                max-width: calc(100vw - 24px);
                max-height: calc(100vh - 24px);
                overflow-y: auto;
                padding: 16px;
                border-radius: 16px;
                background: linear-gradient(180deg, rgba(17, 24, 39, 0.96), rgba(3, 7, 18, 0.94));
                color: #f8fafc;
                box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
                font-family: system-ui, sans-serif;
                backdrop-filter: blur(10px);
            }

            #${PANEL_ID} .ah-header {
                margin-bottom: 12px;
            }

            #${PANEL_ID} .ah-header-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                margin-bottom: 4px;
            }

            #${PANEL_ID} .ah-title {
                font-size: 16px;
                font-weight: 700;
            }

            #${PANEL_ID} .ah-subtitle {
                font-size: 12px;
                color: #cbd5e1;
                line-height: 1.5;
            }

            #${PANEL_ID} .ah-collapse-toggle {
                border: 0;
                border-radius: 8px;
                padding: 4px 8px;
                font-size: 11px;
                font-weight: 700;
                color: #e2e8f0;
                background: rgba(51, 65, 85, 0.9);
                cursor: pointer;
            }

            #${PANEL_ID}.ah-panel.ah-collapsed {
                width: auto;
                max-width: calc(100vw - 24px);
                padding: 12px;
                overflow: hidden;
            }

            #${PANEL_ID}.ah-panel.ah-collapsed .ah-body,
            #${PANEL_ID}.ah-panel.ah-collapsed .ah-subtitle {
                display: none;
            }

            #${PANEL_ID}.ah-panel.ah-collapsed .ah-header {
                margin-bottom: 0;
            }

            #${PANEL_ID} .ah-section {
                margin-bottom: 12px;
                padding: 12px;
                border-radius: 12px;
                background: rgba(15, 23, 42, 0.72);
                border: 1px solid rgba(148, 163, 184, 0.15);
            }

            #${PANEL_ID} .ah-section-title {
                margin-bottom: 10px;
                font-size: 13px;
                font-weight: 700;
                color: #e2e8f0;
            }

            #${PANEL_ID} .ah-info {
                display: grid;
                gap: 6px;
                margin-bottom: 10px;
                font-size: 12px;
                min-height: 88px;
            }

            #${PANEL_ID} .ah-loading-placeholder {
                height: 88px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #94a3b8;
                font-size: 12px;
            }

            #${PANEL_ID} .ah-loading-placeholder::after {
                content: '正在加载资料...';
                animation: ah-loading-spin 0.6s linear infinite;
            }

            @keyframes ah-loading-spin {
                0%, 100% { opacity: 0.6; }
                50% { opacity: 1; }
            }

            #${PANEL_ID} .ah-info-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
            }

            #${PANEL_ID} .ah-info-label {
                color: #94a3b8;
            }

            #${PANEL_ID} .ah-info-value {
                color: #f8fafc;
                text-align: right;
                word-break: break-all;
            }

            #${PANEL_ID} .ah-row {
                display: flex;
                gap: 8px;
                margin-bottom: 8px;
            }

            #${PANEL_ID} .ah-toggle {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 8px;
                font-size: 12px;
                color: #cbd5e1;
                user-select: none;
            }

            #${PANEL_ID} .ah-toggle input {
                margin: 0;
            }

            #${PANEL_ID} .ah-button {
                flex: 1;
                border: 0;
                border-radius: 10px;
                padding: 9px 10px;
                font-size: 12px;
                font-weight: 700;
                cursor: pointer;
                transition: transform 0.15s ease, opacity 0.15s ease;
            }

            #${PANEL_ID} .ah-button:hover {
                transform: translateY(-1px);
                opacity: 0.95;
            }

            #${PANEL_ID} .ah-button-primary {
                background: linear-gradient(135deg, #229ed9, #2563eb);
                color: #ffffff;
            }

            #${PANEL_ID} .ah-button-secondary {
                background: rgba(51, 65, 85, 0.95);
                color: #e2e8f0;
            }

            #${PANEL_ID} .ah-message {
                min-height: 18px;
                padding: 0;
                font-size: 12px;
                line-height: 1.5;
                color: #cbd5e1;
                word-break: break-word;
                transition: all 0.2s ease;
            }

            #${PANEL_ID} .ah-message.ah-info,
            #${PANEL_ID} .ah-message.ah-success,
            #${PANEL_ID} .ah-message.ah-error {
                padding: 8px 10px;
                border-radius: 10px;
            }

            #${PANEL_ID} .ah-message.ah-info {
                background: rgba(30, 41, 59, 0.85);
                color: #e2e8f0;
            }

            #${PANEL_ID} .ah-message.ah-success {
                background: rgba(20, 83, 45, 0.85);
                color: #dcfce7;
            }

            #${PANEL_ID} .ah-message.ah-error {
                background: rgba(127, 29, 29, 0.85);
                color: #fecaca;
            }

            #${PANEL_ID} .ah-copy-button {
                margin-top: 8px;
                border: 0;
                border-radius: 8px;
                padding: 6px 10px;
                font-size: 12px;
                font-weight: 700;
                color: #0f172a;
                background: #bfdbfe;
                cursor: pointer;
            }
        `;
        document.head.appendChild(style);
    }

    function getOrCreatePanel() {
        let panel = document.getElementById(PANEL_ID);

        if (!panel) {
            panel = document.createElement('div');
            panel.id = PANEL_ID;
            document.body.appendChild(panel);
        }

        return panel;
    }

})();