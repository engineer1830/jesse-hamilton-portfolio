document.addEventListener("DOMContentLoaded", () => {
    const page = window.location.pathname.split("/").pop(); // index.html or album.html
    const key = `scroll-${page}${window.location.search}`;

    // Restore scroll position AFTER fade-in completes
    requestAnimationFrame(() => {
        const saved = sessionStorage.getItem(key);
        if (saved) {
            window.scrollTo(0, parseInt(saved, 10));
        }
    });

    // Save scroll position before navigating away
    window.addEventListener("beforeunload", () => {
        sessionStorage.setItem(key, window.scrollY);
    });

    // Also save when clicking internal links (works with your fade-out transitions)
    document.querySelectorAll("a[href]").forEach(link => {
        const url = link.getAttribute("href");

        // Only intercept internal navigation
        if (url.startsWith("http") || url.startsWith("#")) return;

        link.addEventListener("click", () => {
            sessionStorage.setItem(key, window.scrollY);
        });
    });
});
