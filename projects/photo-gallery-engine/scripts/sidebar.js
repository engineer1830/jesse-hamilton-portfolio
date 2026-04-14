// Build the left sidebar navigation dynamically
document.addEventListener("DOMContentLoaded", () => {
    const nav = document.getElementById("album-nav");
    if (!nav || !albums) return;

    const params = new URLSearchParams(window.location.search);
    const currentSlug = params.get("slug");

    albums.forEach(album => {
        const link = document.createElement("a");
        link.href = `album.html?slug=${album.slug}`;
        link.textContent = album.title;

        // Highlight the active album
        if (album.slug === currentSlug) {
            link.classList.add("active");
        }

        nav.appendChild(link);
    });
});
