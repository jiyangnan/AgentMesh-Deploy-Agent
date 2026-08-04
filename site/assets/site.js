(() => {
  for (const button of document.querySelectorAll('[data-copy-prompt]')) {
    const panel = button.closest('[data-agent-handoff]');
    const prompt = panel?.querySelector('[data-agent-prompt]');
    if (!prompt) continue;

    const idleLabel = button.textContent;
    const copiedLabel = button.dataset.copiedLabel || 'Copied';
    let resetTimer;

    const writeClipboard = async (text) => {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }

      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    };

    button.addEventListener('click', async () => {
      try {
        await writeClipboard(prompt.textContent.trim());
        button.textContent = copiedLabel;
        button.dataset.state = 'copied';
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          button.textContent = idleLabel;
          delete button.dataset.state;
        }, 1800);
      } catch {
        button.textContent = button.dataset.failedLabel || 'Copy failed';
      }
    });
  }
})();
