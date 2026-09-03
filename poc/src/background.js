importScripts('chat-read-core.js');

const YOUTUBE_API_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const BOOTSTRAP_REQUEST_TYPE = 'GET_PC_WATCH_BOOTSTRAP_SUMMARY';

function extractYtInitialDataFromHtml(html) {
    if (typeof html !== 'string' || !html) return null;
    const marker = /(?:var\s+)?ytInitialData\s*=\s*/g;
    let match;

    while ((match = marker.exec(html)) !== null) {
        const start = html.indexOf('{', match.index + match[0].length);
        if (start < 0) continue;
        let depth = 0;
        let quote = '';
        let escaped = false;
        for (let index = start; index < html.length; index += 1) {
            const character = html[index];
            if (quote) {
                if (escaped) escaped = false;
                else if (character === '\\') escaped = true;
                else if (character === quote) quote = '';
                continue;
            }
            if (character === '"' || character === "'") {
                quote = character;
                continue;
            }
            if (character === '{') depth += 1;
            if (character === '}') {
                depth -= 1;
                if (depth === 0) {
                    try { return JSON.parse(html.slice(start, index + 1)); } catch (error) { break; }
                }
            }
        }
    }
    return null;
}

function summarizePcWatchBootstrap(data) {
    const renderer = data?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
    const continuations = renderer?.continuations;
    return {
        ytInitialDataFound: Boolean(data),
        hasTwoColumnWatchNextResults: Boolean(data?.contents?.twoColumnWatchNextResults),
        hasConversationBar: Boolean(data?.contents?.twoColumnWatchNextResults?.conversationBar),
        hasLiveChatRenderer: Boolean(renderer),
        hasInitialLiveChatContinuation: Boolean(continuations?.[0]?.reloadContinuationData?.continuation)
    };
}

function extractPcInitialContinuation(data) {
    return data?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer
        ?.continuations?.[0]?.reloadContinuationData?.continuation || '';
}

function logBackground(message, extra = '') {
    if (extra) {
        console.log(`[LiveFlow PoC] ${message}`, extra);
        return;
    }
    console.log(`[LiveFlow PoC] ${message}`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === BOOTSTRAP_REQUEST_TYPE) {
        const videoId = String(message.payload?.videoId || '').trim();
        if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
            sendResponse({ ok: false, status: null, errorType: 'invalid-video-id' });
            return true;
        }

        fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, { credentials: 'include' })
            .then(async (response) => {
                if (!response.ok) {
                    sendResponse({ ok: false, status: response.status, errorType: 'http-error' });
                    return;
                }
                const html = await response.text();
                const initialData = extractYtInitialDataFromHtml(html);
                const pcContext = globalThis.LiveFlowChatReadCore?.extractInnertubeContextFromHtml?.(html) || null;
                const htmlProfile = globalThis.LiveFlowChatReadCore?.summarizeWatchHtmlProfile?.(html) || null;
                const embeddingProfile = globalThis.LiveFlowChatReadCore?.summarizeYtInitialDataEmbedding?.(html) || null;
                const contextMarkers = globalThis.LiveFlowChatReadCore?.inspectPcContextBootstrapHtml?.(html) || {
                    configMarkerPresent: false,
                    presentFields: [],
                    contextObjectCandidate: false
                };
                sendResponse({
                    ok: true,
                    status: response.status,
                    summary: {
                        ...summarizePcWatchBootstrap(initialData),
                        contextMarkers,
                        htmlProfile,
                        embeddingProfile
                    },
                    initialContinuation: extractPcInitialContinuation(initialData),
                    pcContext
                });
            })
            .catch(() => sendResponse({ ok: false, status: null, errorType: 'network-error' }));
        return true;
    }

    if (message?.type === 'GET_YOUTUBE_PAGE_STATE') {
        logBackground('Page state requested');
        sendResponse({
            url: sender?.tab?.url || '',
            liveDetected: Boolean(message?.payload?.isLive),
            tabId: sender?.tab?.id || null,
            time: new Date().toISOString()
        });
        return true;
    }

    if (message?.type === 'GET_OAUTH_TOKEN') {
        logBackground('Authentication status: OAuth token request started');
        chrome.identity.getAuthToken({ interactive: true, scopes: [YOUTUBE_API_SCOPE] }, (token) => {
            if (chrome.runtime.lastError) {
                logBackground(`Authentication status: OAuth failed - ${chrome.runtime.lastError.message}`);
                sendResponse({ token: null, error: chrome.runtime.lastError.message });
                return;
            }

            logBackground('Authentication status: OAuth token acquired successfully');
            sendResponse({ token, error: null });
        });
        return true;
    }

    if (message?.type === 'POST_YOUTUBE_CHAT') {
        const { liveChatId, messageText, accessToken } = message.payload || {};
        logBackground('Message send started');
        logBackground(`liveChatId status: ${liveChatId ? 'resolved' : 'missing'}`);

        if (!liveChatId || !messageText || !accessToken) {
            logBackground('Message send result: missing payload');
            sendResponse({ ok: false, error: 'Missing required payload' });
            return true;
        }

        fetch('https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                snippet: {
                    liveChatId,
                    type: 'textMessageEvent',
                    textMessageDetails: {
                        messageText
                    }
                }
            })
        })
            .then(async (response) => {
                const text = await response.text();
                let data = {};
                try { data = JSON.parse(text); } catch (error) { }
                logBackground(`Message send result: ${response.ok ? 'success' : 'failure'} (${response.status})`);
                sendResponse({ ok: response.ok, status: response.status, data });
            })
            .catch((error) => {
                logBackground(`Message send result: exception - ${error.message}`);
                sendResponse({ ok: false, error: error.message });
            });

        return true;
    }

    return false;
});

chrome.runtime.onInstalled.addListener(() => {
    logBackground('Extension installed; ready for YouTube live page validation');
});
