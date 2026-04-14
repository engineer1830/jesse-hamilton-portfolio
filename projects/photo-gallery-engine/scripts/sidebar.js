// Build the left sidebar navigation dynamically
document.addEventListener("DOMContentLoaded", () => {
    const nav = document.getElementById("album-nav");
    if (!nav || !albums) return;

    const params = new URLSearchParams(window.location.search);
    const currentSlug = params.get("slug");

    albums.forEach(album => {
        const link = document.createElement("a");

        const count =
            (window.photos && photos[album.slug] && photos[album.slug].length) ||
            album.count ||
            0;

        link.href = `album.html?slug=${album.slug}`;
        link.innerHTML = `${album.title} <span class="count">(${count})</span>`;

        if (album.slug === currentSlug) {
            link.classList.add("active");
        }

        nav.appendChild(link);
    });    
});

