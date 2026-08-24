/* ============================================================
   config.js — CineVerse API Keys
   ============================================================
   ✅ TMDB  — safe to expose (read-only public data)
   ✅ Firebase — safe to expose (domain restricted)
   ❌ Groq — stored in Netlify Environment Variables only
   ============================================================ */

const CONFIG = {

  // Get your free TMDB key at: https://www.themoviedb.org/settings/api
  TMDB_API_KEY: "9f772729560d2b3a75e1f63fc5e94d25",


  // Get your Firebase config at: https://console.firebase.google.com
  FIREBASE: {
        apiKey: "AIzaSyA0sonesYP_gooCK-tjzvFn8zYPE4PhAHE",
        authDomain: "cineverse-1f903.firebaseapp.com",
        projectId: "cineverse-1f903",
        storageBucket: "cineverse-1f903.firebasestorage.app",
        messagingSenderId: "853116750203",
        appId: "1:853116750203:web:7de0619cc4a0ba527d15de"
  }

  // ⚠️ No Groq key here — it lives in Netlify Environment Variables
  // Groq requests go through /netlify/functions/chat.js
  
};