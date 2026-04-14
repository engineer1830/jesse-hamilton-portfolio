document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("menu-toggle");
    const sidebar = document.getElementById("sidebar");

    toggle.addEventListener("click", () => {
        sidebar.classList.toggle("open");
    });

    // Close sidebar when clicking outside (mobile only)
    document.addEventListener("click", (e) => {
        if (window.innerWidth > 700) return;

        const clickedInsideSidebar = sidebar.contains(e.target);
        const clickedToggle = toggle.contains(e.target);

        if (!clickedInsideSidebar && !clickedToggle) {
            sidebar.classList.remove("open");
        }
    });
});
