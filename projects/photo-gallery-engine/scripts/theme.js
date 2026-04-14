document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("theme-toggle");
    const body = document.body;

    // Load saved preference
    const saved = localStorage.getItem("theme");
    if (saved === "dark") {
        body.classList.add("dark");
    }

    toggle.addEventListener("click", () => {
        body.classList.toggle("dark");

        // Save preference
        const mode = body.classList.contains("dark") ? "dark" : "light";
        localStorage.setItem("theme", mode);
    });
});
