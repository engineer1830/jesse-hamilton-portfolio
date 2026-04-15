// Load albums into the homepage grid
document.addEventListener("DOMContentLoaded", () => {
    const container = document.getElementById("album-container");

    // -------------------------------
    // 1. Sorting mode (G2)
    // -------------------------------
    let albumSort = "date-desc";
    // Options:
    // "date-desc", "date-asc",
    // "name-asc", "name-desc",
    // "count-desc", "count-asc",
    // "custom"

    // -------------------------------
    // 2. Sorting function (G2)
    // -------------------------------
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

    // -------------------------------
    // 3. Sort albums BEFORE rendering
    // -------------------------------
    const sortedAlbums = sortAlbums([...albums]);
    // Spread operator prevents mutating the global albums array

    // -------------------------------
    // 4. Render sorted albums
    // -------------------------------
    sortedAlbums.forEach((album, i) => {
        const card = document.createElement("div");
        card.className = "album-card";

        // Animation index for staggered fade-in
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
});
