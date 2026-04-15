document.addEventListener("DOMContentLoaded", () => {
    const container = document.getElementById("album-container");
    const searchInput = document.getElementById("album-search");

    let albumSort = "date-desc"; // G2
    let searchQuery = "";        // G3

    function sortAlbums(list) {
        switch (albumSort) {
            case "date-desc":
                return list.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
            case "date-asc":
                return list.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
            case "name-asc":
                return list.sort((a, b) => a.title.localeCompare(b.title));
            case "name-desc":
                return list.sort((a, b) => b.title.localeCompare(a.title));
            case "count-desc":
                return list.sort((a, b) => (b.count || 0) - (a.count || 0));
            case "count-asc":
                return list.sort((a, b) => (a.count || 0) - (b.count || 0));
            case "custom":
                return list.sort((a, b) => (a.order || 0) - (b.order || 0));
            default:
                return list;
        }
    }

    function filterAlbums(list) {
        if (!searchQuery) return list;
        const q = searchQuery.toLowerCase();

        return list.filter(album => {
            return (
                album.title?.toLowerCase().includes(q) ||
                album.location?.toLowerCase().includes(q) ||
                album.description?.toLowerCase().includes(q)
            );
        });
    }

    function renderAlbums() {
        container.innerHTML = "";

        const base = [...albums];
        const filtered = filterAlbums(base);
        const sorted = sortAlbums(filtered);

        sorted.forEach((album, i) => {
            const card = document.createElement("div");
            card.className = "album-card";
            card.style.setProperty("--i", i);

            card.innerHTML = `
                <img class="album-thumb" src="${album.cover}" alt="${album.title}" loading="lazy">
                <h3>${album.title}</h3>

                <p class="album-meta">
                    ${album.date ? `<span>${album.date}</span>` : ""}
                    ${album.location ? `<span>• ${album.location}</span>` : ""}
                    <span>• ${album.count} photos</span>
                </p>

                ${album.description ? `<p class="album-description">${album.description}</p>` : ""}
            `;

            card.addEventListener("click", () => {
                window.location.href = `album.html?slug=${album.slug}`;
            });

            container.appendChild(card);
        });
    }

    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            searchQuery = e.target.value.trim();
            renderAlbums();
        });
    }

    renderAlbums();
});
