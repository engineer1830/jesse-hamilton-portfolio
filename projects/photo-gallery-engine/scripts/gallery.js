// Load albums into the homepage grid
document.addEventListener("DOMContentLoaded", () => {
    const container = document.getElementById("album-container");

    albums.forEach((album, i) => {
        const card = document.createElement("div");
        card.className = "album-card";

        // Animation index for staggered fade-in
        card.style.setProperty("--i", i);

        card.innerHTML = `
            <img class="album-thumb" src="${album.cover}" alt="${album.title}">
            <h3>${album.title}</h3>
            <p>${album.count} photos</p>
        `;

        card.addEventListener("click", () => {
            window.location.href = `album.html?slug=${album.slug}`;
        });

        container.appendChild(card);
    });
});
