// Parse album slug from URL
const params = new URLSearchParams(window.location.search);
const slug = params.get("slug");

// Get album metadata
const album = albums.find(a => a.slug === slug);

// Update title
document.getElementById("album-title").textContent = album?.title || "Album";

// Load photos
const grid = document.getElementById("photo-grid");
const albumPhotos = photos[slug] || [];

albumPhotos.forEach((src, index) => {
    const img = document.createElement("img");
    img.src = photo.src;
    img.alt = photo.alt || "";
    img.className = "photo-thumb";
    img.loading = "lazy";

    // Animation index for staggered fade-in
    img.style.setProperty("--i", index);

    img.addEventListener("click", () => openLightbox(src, index));

    grid.appendChild(img);
});

// Lightbox logic
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const closeBtn = document.getElementById("lightbox-close");
const prevBtn = document.getElementById("lightbox-prev");
const nextBtn = document.getElementById("lightbox-next");

let currentIndex = 0;

function openLightbox(src, index) {
    currentIndex = index;
    lightboxImg.src = src;
    lightbox.classList.remove("hidden");
}

function closeLightbox() {
    lightbox.classList.add("hidden");
}

function showNext() {
    currentIndex = (currentIndex + 1) % albumPhotos.length;
    lightboxImg.src = albumPhotos[currentIndex];
}

function showPrev() {
    currentIndex = (currentIndex - 1 + albumPhotos.length) % albumPhotos.length;
    lightboxImg.src = albumPhotos[currentIndex];
}

// Event listeners
closeBtn.addEventListener("click", closeLightbox);
nextBtn.addEventListener("click", showNext);
prevBtn.addEventListener("click", showPrev);

lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
});

// Keyboard navigation
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowRight") showNext();
    if (e.key === "ArrowLeft") showPrev();
});

// Fade-in on scroll using IntersectionObserver
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
        }
    });
}, { threshold: 0.1 });

document.querySelectorAll(".photo-thumb").forEach(img => {
    observer.observe(img);
});
