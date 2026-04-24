// scripts/guide.js

// Footer date
const el = document.getElementById("last-updated-date");
if (el) {
    const today = new Date();
    el.textContent = today.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric"
    });
}

// Scroll to top
const scrollBtn = document.getElementById("scroll-top-btn");
if (scrollBtn) {
    scrollBtn.addEventListener("click", () => {
        window.scrollTo({
            top: 0,
            behavior: "smooth"
        });
    });
}


