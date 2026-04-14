// Parse album slug from URL
const params = new URLSearchParams(window.location.search);
const slug = params.get("slug");

// Get album metadata
const album = albums.find(a => a.slug === slug);

// Update title + breadcrumb
document.getElementById("album-title").textContent = album?.title || "Album";
document.getElementById("breadcrumb-album").textContent = album.title;

// Album metadata
const meta = [];

if (album.date) meta.push(album.date);
if (album.location) meta.push(album.location);
meta.push(`${album.count} photos`);

document.getElementById("album-meta").textContent = meta.join(" • ");
document.getElementById("album-description").textContent = album.description || "";


// Load photos
const grid = document.getElementById("photo-grid");
const albumPhotos = photos[slug] || [];

albumPhotos.forEach((photo, index) => {
    const img = document.createElement("img");

    // Support both objects and strings (backwards compatible)
    const src = typeof photo === "string" ? photo : photo.src;
    const alt = typeof photo === "string" ? album.title : (photo.caption || album.title);

    img.src = src;
    img.alt = alt;
    img.className = "photo-thumb";
    img.loading = "lazy";

    // Animation index for staggered fade-in
    img.style.setProperty("--i", index);

    img.addEventListener("click", () => openLightbox(index));

    grid.appendChild(img);
});

// Lightbox logic
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const closeBtn = document.getElementById("lightbox-close");
const prevBtn = document.getElementById("lightbox-prev");
const nextBtn = document.getElementById("lightbox-next");
const backLink = document.getElementById("lightbox-back");

let currentIndex = 0;

function openLightbox(index) {
    currentIndex = index;

    const photo = albumPhotos[index];
    const src = typeof photo === "string" ? photo : photo.src;

    lightboxImg.src = src;
    lightbox.classList.remove("hidden");

    // Update caption
    const captionEl = document.getElementById("lightbox-caption");
    if (captionEl) {
        if (typeof photo === "string") {
            captionEl.textContent = "";
        } else {
            let text = photo.caption || "";
            if (photo.location) text += ` • ${photo.location}`;
            if (photo.date) text += ` • ${photo.date}`;
            captionEl.textContent = text;
        }
    }

    if (backLink) backLink.style.display = "block";
}


function closeLightbox() {
    lightbox.classList.add("hidden");

    // Hide back link when lightbox closes
    if (backLink) backLink.style.display = "none";
}

function showNext() {
    currentIndex = (currentIndex + 1) % albumPhotos.length;

    const photo = albumPhotos[currentIndex];
    const src = typeof photo === "string" ? photo : photo.src;

    lightboxImg.src = src;

    // Update caption
    updateCaption(photo);
}

function showPrev() {
    currentIndex = (currentIndex - 1 + albumPhotos.length) % albumPhotos.length;

    const photo = albumPhotos[currentIndex];
    const src = typeof photo === "string" ? photo : photo.src;

    lightboxImg.src = src;

    // Update caption
    updateCaption(photo);
}

function updateCaption(photo) {
    const captionEl = document.getElementById("lightbox-caption");
    if (!captionEl) return;

    if (typeof photo === "string") {
        captionEl.textContent = "";
        return;
    }

    let text = photo.caption || "";
    if (photo.location) text += ` • ${photo.location}`;
    if (photo.date) text += ` • ${photo.date}`;
    captionEl.textContent = text;
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

// Observe all thumbnails AFTER they exist
document.querySelectorAll(".photo-thumb").forEach(img => {
    observer.observe(img);
});
