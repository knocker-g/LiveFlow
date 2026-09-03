const statusEl = document.getElementById('status');
const sendBtn = document.getElementById('sendBtn');
const authBtn = document.getElementById('authBtn');
const messageInput = document.getElementById('messageInput');

function setStatus(text) {
    statusEl.textContent = text;
}

async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

async function detectTabState() {
    const tab = await getCurrentTab();
    if (!tab || !tab.id) {
        setStatus('No active tab available');
        return;
    }

    try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_DETECTION' });
        setStatus(response?.detected ? 'YouTube Live detected' : 'No live page detected');
        console.log('[LiveFlow PoC] Popup page detection result:', response);
    } catch (error) {
        setStatus(`Detection error: ${error.message}`);
        console.log('[LiveFlow PoC] Popup detection error:', error.message);
    }
}

sendBtn.addEventListener('click', async () => {
    try {
        const tab = await getCurrentTab();
        const response = await chrome.tabs.sendMessage(tab.id, {
            type: 'SEND_TEST_MESSAGE',
            payload: { message: messageInput.value.trim() }
        });

        console.log('[LiveFlow PoC] Send test result:', response);
        setStatus(response?.ok ? 'Message submitted' : (response?.error || 'Message not submitted'));
    } catch (error) {
        console.log('[LiveFlow PoC] Send test error:', error.message);
        setStatus(`Error: ${error.message}`);
    }
});

authBtn.addEventListener('click', async () => {
    try {
        const result = await chrome.runtime.sendMessage({ type: 'GET_OAUTH_TOKEN' });
        console.log('[LiveFlow PoC] OAuth result:', result ? 'token acquired' : 'token missing');
        setStatus(result?.token ? 'Token acquired' : `OAuth error: ${result?.error || 'unknown'}`);
    } catch (error) {
        console.log('[LiveFlow PoC] OAuth error:', error.message);
        setStatus(`OAuth error: ${error.message}`);
    }
});

detectTabState();
