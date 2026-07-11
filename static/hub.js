// meso.utilities — hub (master page) interactions.
// "Share to Slack": Slack has no public post-a-message URL, and this hub has no
// backend, so we copy a ready-to-paste message to the clipboard instead.
const shareBtn = document.getElementById("share-slack");
const toast = document.getElementById("toast");
let toastTimer;

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

if (shareBtn) {
  shareBtn.addEventListener("click", async () => {
    const message = `meso.utilities — small tools for the team: ${location.href}`;
    try {
      await navigator.clipboard.writeText(message);
      showToast("Copied — paste it into Slack 💬");
    } catch {
      showToast("Couldn't copy — the link is in the address bar");
    }
  });
}
