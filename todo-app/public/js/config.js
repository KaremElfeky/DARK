// Where the notification server lives.
//
// ''  -> same origin as the website (default; works when you run `npm start`,
//        because server.js serves this folder AND the /api endpoints).
//
// If you host the website somewhere else (GitHub Pages, Netlify, Hugging Face…)
// and run server.js on another host, put its full URL here, for example:
//   export const API_BASE = 'https://mahami-push.onrender.com';
export const API_BASE = '';

export const apiUrl = (path) => (API_BASE ? `${API_BASE.replace(/\/$/, '')}/${path}` : path);
