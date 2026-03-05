/** @type {import('tailwindcss').Config} */
export default {
    content: ["./index.html", "./src/**/*.{js,jsx}"],
    theme: {
        extend: {
            boxShadow: {
                glow: "0 10px 40px rgba(0,0,0,0.35)"
            }
        }
    },
    plugins: []
};
