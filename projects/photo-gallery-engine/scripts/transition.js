document.addEventListener("DOMContentLoaded", () => {
    // Fade in when page loads
    document.body.classList.add("fade-in");

    // Intercept all internal links for fade-out
    document.querySelectorAll("a[href]").forEach(link => {
        const url = link.getAttribute("href");

        // Only intercept internal navigation
        if (url.startsWith("http") || url.startsWith("#")) return;

        link.addEventListener("click", (e) => {
            e.preventDefault();
            document.body.classList.remove("fade-in");

            setTimeout(() => {
                window.location.href = url;
            }, 300); // matches CSS transition
        });
    });
});
