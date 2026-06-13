/* ==========================================
   CineVerse — script.js
   TMDB API + Groq AI Chatbot
   ========================================== */

// ============================================================
//  🔑  API KEYS — loaded from config.local.js (local) or config.js (GitHub placeholder)
//  ➡️  Never hardcode real keys here!
// ============================================================
const TMDB_API_KEY = CONFIG.TMDB_API_KEY;      // https://www.themoviedb.org/settings/api
// ✅ No Groq key here — handled server-side via /netlify/functions/chat.js

// ============================================================
//  🔥 FIREBASE CONFIG — loaded from CONFIG object
// ============================================================
const firebaseConfig = CONFIG.FIREBASE;

firebase.initializeApp(firebaseConfig);
const auth      = firebase.auth();
const db        = firebase.firestore();
const provider  = new firebase.auth.GoogleAuthProvider();

// Set persistence to LOCAL so session survives page redirects
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

// Current logged-in user
let currentUser = null;

// ============================================================
//  AUTH — Sign In / Sign Out
// ============================================================
function signInWithGoogle() {
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
    .then(() => auth.signInWithPopup(provider))
    .then(result => {
      console.log("✅ Signed in:", result.user.displayName);
    })
    .catch(err => {
      console.error("Sign-in error:", err.code, err.message);
      // If popup blocked, fallback to redirect
      if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-closed-by-user') {
        auth.signInWithRedirect(provider);
      } else {
        showToast("⚠️ Sign-in failed: " + err.message);
      }
    });
}

function signOut() {
  auth.signOut().then(() => {
    showToast("👋 Signed out successfully.");
    toggleUserDropdown(true);
  });
}

function toggleUserDropdown(forceClose = false) {
  const dd = document.getElementById("userDropdown");
  if (forceClose) { dd.classList.remove("open"); return; }
  dd.classList.toggle("open");
}

// Close dropdown when clicking outside
document.addEventListener("click", e => {
  const menu = document.getElementById("userMenu");
  if (menu && !menu.contains(e.target)) {
    const dd = document.getElementById("userDropdown");
    if (dd) dd.classList.remove("open");
  }
});

function closeLoginModal(event) {
  const modal = document.getElementById("loginModal");
  if (event && event.target !== modal) return;
  if (!event) modal.classList.remove("active");
  else modal.classList.remove("active");
}

// ============================================================
//  AUTH STATE LISTENER — runs on every page load
// ============================================================
// Handle redirect result FIRST, then listen for auth state
auth.getRedirectResult().then(result => {
  if (result && result.user) {
    console.log("✅ Redirect sign-in success:", result.user.displayName);
  }
}).catch(err => {
  console.error("Redirect result error:", err.code, err.message);
});

auth.onAuthStateChanged(async user => {
  console.log("🔥 Auth state changed:", user ? user.displayName : "logged out");
  currentUser = user;

  const loginBtn  = document.getElementById("loginBtn");
  const userMenu  = document.getElementById("userMenu");
  const loginModal= document.getElementById("loginModal");

  if (user) {
    // --- LOGGED IN ---
    loginBtn.style.display  = "none";
    userMenu.style.display  = "flex";
    loginModal.classList.remove("active");

    // Set avatar and name
    document.getElementById("userAvatar").src      = user.photoURL || "";
    document.getElementById("dropdownAvatar").src  = user.photoURL || "";
    document.getElementById("userName").textContent  = user.displayName || "User";
    document.getElementById("userEmail").textContent = user.email || "";

    // Load watchlist from Firestore
    await loadWatchlistFromFirestore();
    showToast(`👋 Welcome back, ${user.displayName?.split(" ")[0]}!`);

  } else {
    // --- LOGGED OUT ---
    loginBtn.style.display  = "flex";
    userMenu.style.display  = "none";
    // Fall back to localStorage watchlist
    updateWlCount();
  }
});

// ============================================================
//  FIRESTORE WATCHLIST — Cloud sync
// ============================================================
async function loadWatchlistFromFirestore() {
  if (!currentUser) return;
  try {
    const doc = await db.collection("watchlists").doc(currentUser.uid).get();
    if (doc.exists) {
      const cloudList = doc.data().movies || [];
      // Merge with localStorage (cloud takes priority)
      localStorage.setItem("cineverse_watchlist", JSON.stringify(cloudList));
    }
    updateWlCount();
  } catch (e) {
    console.error("Firestore load error:", e);
  }
}

async function saveWatchlistToFirestore(list) {
  if (!currentUser) return;
  try {
    await db.collection("watchlists").doc(currentUser.uid).set({ movies: list });
  } catch (e) {
    console.error("Firestore save error:", e);
  }
}


// ============================================================
//  RATINGS — Firebase Firestore
// ============================================================

async function rateMovie(movieId, movieTitle, rating) {
  if (!currentUser) {
    showToast("⚠️ Please sign in to rate movies!");
    document.getElementById("loginModal").classList.add("active");
    return;
  }
  try {
    await db.collection("ratings").doc(`${currentUser.uid}_${movieId}`).set({
      userId: currentUser.uid, movieId, movieTitle, rating, updatedAt: new Date()
    });
    const aggRef  = db.collection("movieRatings").doc(String(movieId));
    const aggSnap = await aggRef.get();
    if (aggSnap.exists) {
      const data = aggSnap.data();
      const oldRatings = data.ratings || {};
      const prevRating = oldRatings[currentUser.uid];
      let total = data.total || 0;
      let count = data.count || 0;
      if (prevRating) { total = total - prevRating + rating; }
      else { total = total + rating; count = count + 1; }
      oldRatings[currentUser.uid] = rating;
      await aggRef.set({ total, count, ratings: oldRatings, movieTitle });
    } else {
      await aggRef.set({ total: rating, count: 1, ratings: { [currentUser.uid]: rating }, movieTitle });
    }
    showToast(`⭐ You rated "${movieTitle}" ${rating}/5!`);
    updateStarUI(movieId, rating);
    loadMovieAvgRating(movieId);
  } catch (e) { console.error("Rating error:", e); showToast("⚠️ Could not save rating!"); }
}

async function getUserRating(movieId) {
  if (!currentUser) return 0;
  try {
    const doc = await db.collection("ratings").doc(`${currentUser.uid}_${movieId}`).get();
    return doc.exists ? doc.data().rating : 0;
  } catch (e) { return 0; }
}

async function getAvgRating(movieId) {
  try {
    const doc = await db.collection("movieRatings").doc(String(movieId)).get();
    if (doc.exists) {
      const { total, count } = doc.data();
      return count > 0 ? (total / count).toFixed(1) : null;
    }
    return null;
  } catch (e) { return null; }
}

async function loadMovieAvgRating(movieId) {
  const avg = await getAvgRating(movieId);
  const el  = document.getElementById(`avg-rating-${movieId}`);
  if (el) el.textContent = avg ? `⭐ ${avg}/5 community rating` : "No ratings yet";
}

function updateStarUI(movieId, rating) {
  document.querySelectorAll(`.star-btn[data-movie-id="${movieId}"]`).forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.value) <= rating);
  });
}

async function buildStarRating(movieId, movieTitle, isModal = false) {
  const userRating = await getUserRating(movieId);
  const size = isModal ? "modal-star" : "card-star";
  let html = `<div class="star-rating ${size}" data-movie-id="${movieId}">`;
  for (let i = 1; i <= 5; i++) {
    html += `<button class="star-btn ${i <= userRating ? "active" : ""}" data-value="${i}" data-movie-id="${movieId}" data-movie-title="${escapeHtml(movieTitle)}" title="Rate ${i} star" onclick="rateMovie(${movieId}, this.dataset.movieTitle, ${i}); event.stopPropagation()">★</button>`;
  }
  html += `</div>`;
  return html;
}


// ============================================================
//  TMDB CONFIG
// ============================================================
const TMDB_BASE   = "https://api.themoviedb.org/3";
const TMDB_IMG    = "https://image.tmdb.org/t/p/w500";
const TMDB_IMG_LG = "https://image.tmdb.org/t/p/w780";

// TMDB Genre ID map (used to convert genre name → ID for filtering)
const GENRE_MAP = {
  "Action": 28, "Adventure": 12, "Animation": 16, "Comedy": 35,
  "Crime": 80, "Drama": 18, "Fantasy": 14, "Horror": 27,
  "Mystery": 9648, "Romance": 10749, "Sci-Fi": 878, "Thriller": 53
};

// TV Genre ID map (TMDB uses different IDs for TV)
const TV_GENRE_MAP = {
  "Action": 10759, "Adventure": 10759, "Animation": 16, "Comedy": 35,
  "Crime": 80, "Drama": 18, "Fantasy": 10765, "Horror": 9648,
  "Mystery": 9648, "Romance": 10749, "Sci-Fi": 10765, "Thriller": 9648
};

// ============================================================
//  TMDB API HELPERS
// ============================================================

// Search movies by keyword/query
async function tmdbSearch(query, page = 1) {
  const url = `${TMDB_BASE}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&page=${page}&include_adult=false`;
  const res = await fetch(url);
  return res.json();
}

// Get movie full details by TMDB movie ID
async function tmdbGetById(movieId) {
  const url = `${TMDB_BASE}/movie/${movieId}?api_key=${TMDB_API_KEY}&append_to_response=credits,release_dates`;
  const res = await fetch(url);
  return res.json();
}

// Discover movies by genre ID, with optional sort
async function tmdbDiscoverByGenre(genreId, page = 1) {
  const url = `${TMDB_BASE}/discover/movie?api_key=${TMDB_API_KEY}&with_genres=${genreId}&sort_by=popularity.desc&page=${page}&include_adult=false`;
  const res = await fetch(url);
  return res.json();
}

// Search people (actor/actress) → returns person results
async function tmdbSearchPerson(name) {
  const url = `${TMDB_BASE}/search/person?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(name)}&include_adult=false`;
  const res = await fetch(url);
  return res.json();
}

// Get movies by person (actor/actress) ID
async function tmdbMoviesByPerson(personId, page = 1) {
  const url = `${TMDB_BASE}/discover/movie?api_key=${TMDB_API_KEY}&with_cast=${personId}&sort_by=popularity.desc&page=${page}&include_adult=false`;
  const res = await fetch(url);
  return res.json();
}

// Trending movies this week (TMDB has a real trending endpoint!)
async function tmdbTrending() {
  const url = `${TMDB_BASE}/trending/movie/week?api_key=${TMDB_API_KEY}`;
  const res = await fetch(url);
  return res.json();
}

// Popular movies (default discover)
async function tmdbPopular(page = 1) {
  const url = `${TMDB_BASE}/movie/popular?api_key=${TMDB_API_KEY}&page=${page}`;
  const res = await fetch(url);
  return res.json();
}

// Search TV shows
async function tmdbSearchTV(query, page = 1) {
  const url = `${TMDB_BASE}/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&page=${page}&include_adult=false`;
  const res = await fetch(url);
  return res.json();
}

// Get TV show details
async function tmdbGetTVById(tvId) {
  const url = `${TMDB_BASE}/tv/${tvId}?api_key=${TMDB_API_KEY}&append_to_response=credits,content_ratings`;
  const res = await fetch(url);
  return res.json();
}

// Discover TV by genre
async function tmdbDiscoverTVByGenre(genreId, page = 1) {
  const url = `${TMDB_BASE}/discover/tv?api_key=${TMDB_API_KEY}&with_genres=${genreId}&sort_by=popularity.desc&page=${page}&include_adult=false`;
  const res = await fetch(url);
  return res.json();
}

// Trending TV this week
async function tmdbTrendingTV() {
  const url = `${TMDB_BASE}/trending/tv/week?api_key=${TMDB_API_KEY}`;
  const res = await fetch(url);
  return res.json();
}

// Popular TV
async function tmdbPopularTV(page = 1) {
  const url = `${TMDB_BASE}/tv/popular?api_key=${TMDB_API_KEY}&page=${page}`;
  const res = await fetch(url);
  return res.json();
}

// ============================================================
//  STATE
// ============================================================
let currentQuery   = "";
let currentPage    = 1;
let totalResults   = 0;
let totalPages     = 0;
let currentMode    = "popular";   // "popular" | "search" | "genre" | "person"
let currentGenreId = null;
let currentPersonId= null;
let currentType    = "movie";     // "movie" | "tv" | "both"
let debounceTimer  = null;
let chatHistory    = [];

// ============================================================
//  HERO SEARCH
// ============================================================
function heroSearch() {
  const q = document.getElementById("heroSearch").value.trim();
  if (!q) return;
  document.getElementById("discover").scrollIntoView({ behavior: "smooth" });
  setTimeout(() => runSearch(q), 500);
}

function quickSearch(genre) {
  document.getElementById("discover").scrollIntoView({ behavior: "smooth" });
  setTimeout(() => {
    document.getElementById("genreFilter").value = genre;
    applyFilters();
  }, 500);
}

function scrollToDiscover() {
  document.getElementById("discover").scrollIntoView({ behavior: "smooth" });
}

// ============================================================
//  FILTER BAR
// ============================================================
function debounceFilter() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilters, 700);
}

async function applyFilters() {
  const genre    = document.getElementById("genreFilter").value.trim();
  const actor    = document.getElementById("actorFilter").value.trim();
  const actress  = document.getElementById("actressFilter").value.trim();
  const charType = document.getElementById("characterFilter").value;

  const charKeywordMap = {
    superhero: "superhero", villain: "villain", detective: "detective",
    warrior: "warrior", romance: "romance", antihero: "antihero",
    comedy: "comedy", spy: "spy",
  };

  const personQuery = actor || actress;

  if (currentType === "tv") {
    // TV mode
    if (personQuery) {
      runSearch(personQuery + (genre ? ` ${genre}` : ""));
    } else if (genre && TV_GENRE_MAP[genre]) {
      runTVGenreSearch(TV_GENRE_MAP[genre], genre, 1);
    } else if (charType) {
      runSearchTV(charKeywordMap[charType] || charType, 1);
    } else {
      runPopularTV(1);
    }
    return;
  }

  if (currentType === "both") {
    const q = personQuery || genre || (charType ? charKeywordMap[charType] : "") || "popular";
    runSearchBoth(q, 1);
    return;
  }

  // Movie mode (default)
  const personData2 = personQuery ? await tmdbSearchPerson(personQuery) : null;
  const person = personData2?.results?.[0];
  if (person) {
    currentMode = "person"; currentPersonId = person.id;
    if (genre && GENRE_MAP[genre]) runPersonGenreSearch(person.id, GENRE_MAP[genre], `${person.name} · ${genre}`);
    else runPersonSearch(person.id, person.name, 1);
  } else if (genre && GENRE_MAP[genre]) {
    currentMode = "genre"; currentGenreId = GENRE_MAP[genre];
    runGenreSearch(GENRE_MAP[genre], genre, 1);
  } else if (charType) {
    currentMode = "search"; runSearch(charKeywordMap[charType] || charType);
  } else {
    currentMode = "popular"; runPopular(1);
  }
}

async function runSearchTV(query, page = 1) {
  currentQuery = query; currentPage = page; currentMode = "search";
  showGridLoading(query);
  try {
    const data   = await tmdbSearchTV(query, page);
    const items  = (data.results || []).map(normalizeTV);
    totalResults = data.total_results || 0;
    totalPages   = data.total_pages  || 1;
    renderMovies(items, page, totalResults, `"${escapeHtml(query)}"`);
  } catch (err) { showGridError(); }
}

async function runTVGenreSearch(genreId, label, page = 1) {
  currentPage = page;
  showGridLoading(label);
  try {
    const data   = await tmdbDiscoverTVByGenre(genreId, page);
    const items  = (data.results || []).map(normalizeTV);
    totalResults = data.total_results || 0;
    totalPages   = data.total_pages  || 1;
    renderMovies(items, page, totalResults, `<strong>${escapeHtml(label)}</strong> series`);
  } catch (err) { showGridError(); }
}

async function runSearchBoth(query, page = 1) {
  currentQuery = query; currentPage = page; currentMode = "search";
  showGridLoading(query);
  try {
    const [movies, shows] = await Promise.all([
      tmdbSearch(query, page),
      tmdbSearchTV(query, page)
    ]);
    const combined = [
      ...(movies.results || []),
      ...(shows.results || []).map(normalizeTV)
    ].sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
    totalResults = (movies.total_results || 0) + (shows.total_results || 0);
    totalPages   = 1;
    renderMovies(combined, 1, totalResults, `"${escapeHtml(query)}"`);
  } catch (err) { showGridError(); }
}

// Normalize TV show object to look like a movie object
function normalizeTV(show) {
  return {
    id:           show.id,
    title:        show.name || show.title,
    poster_path:  show.poster_path,
    vote_average: show.vote_average,
    vote_count:   show.vote_count,
    release_date: show.first_air_date || show.release_date,
    _isTV:        true   // flag so modal knows to use TV endpoint
  };
}

function resetFilters() {
  document.getElementById("genreFilter").value     = "";
  document.getElementById("actorFilter").value     = "";
  document.getElementById("actressFilter").value   = "";
  document.getElementById("characterFilter").value = "";
  currentMode = "popular";
  runPopular(1);
}

function setType(type, btn) {
  currentType = type;
  // Update toggle button styles
  document.querySelectorAll(".type-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  // Re-run current mode with new type
  currentPage = 1;
  currentMode = "popular";
  if (type === "tv") {
    runPopularTV(1);
  } else {
    runPopular(1);
  }
}

async function runPopularTV(page = 1) {
  currentPage = page;
  showGridLoading("popular web series");
  try {
    const data   = await tmdbPopularTV(page);
    const items  = (data.results || []).map(normalizeTV);
    totalResults = data.total_results || 0;
    totalPages   = data.total_pages  || 1;
    renderMovies(items, page, totalResults, "Popular Web Series");
  } catch (err) {
    showGridError();
  }
}

// ============================================================
//  SEARCH RUNNERS
// ============================================================

// Keyword search
async function runSearch(query, page = 1) {
  currentQuery = query;
  currentPage  = page;
  currentMode  = "search";
  showGridLoading(query);

  try {
    let movies, total, pages;
    if (currentType === "tv") {
      const data = await tmdbSearchTV(query, page);
      movies = (data.results || []).map(normalizeTV);
      total  = data.total_results || 0;
      pages  = data.total_pages   || 1;
    } else {
      const data = await tmdbSearch(query, page);
      movies = data.results || [];
      total  = data.total_results || 0;
      pages  = data.total_pages   || 1;
    }
    totalResults = total;
    totalPages   = pages;
    renderMovies(movies, page, totalResults, `"${escapeHtml(query)}"`);
  } catch (err) {
    showGridError();
    console.error(err);
  }
}

// Genre discover
async function runGenreSearch(genreId, genreLabel, page = 1) {
  currentPage    = page;
  currentGenreId = genreId;
  showGridLoading(genreLabel);

  try {
    const data   = await tmdbDiscoverByGenre(genreId, page);
    const movies = data.results || [];
    totalResults = data.total_results || 0;
    totalPages   = data.total_pages  || 1;

    renderMovies(movies, page, totalResults, `<strong>${escapeHtml(genreLabel)}</strong> films`);
  } catch (err) {
    showGridError();
    console.error(err);
  }
}

// Person movies
async function runPersonSearch(personId, personName, page = 1) {
  currentPage     = page;
  currentPersonId = personId;
  showGridLoading(personName);

  try {
    const data   = await tmdbMoviesByPerson(personId, page);
    const movies = data.results || [];
    totalResults = data.total_results || 0;
    totalPages   = data.total_pages  || 1;

    renderMovies(movies, page, totalResults, `movies featuring <strong>${escapeHtml(personName)}</strong>`);
  } catch (err) {
    showGridError();
    console.error(err);
  }
}

// Person + genre combo
async function runPersonGenreSearch(personId, genreId, label) {
  currentPage = 1;
  showGridLoading(label);
  try {
    const url  = `${TMDB_BASE}/discover/movie?api_key=${TMDB_API_KEY}&with_cast=${personId}&with_genres=${genreId}&sort_by=popularity.desc&include_adult=false`;
    const res  = await fetch(url);
    const data = await res.json();
    const movies = data.results || [];
    totalResults = data.total_results || 0;
    totalPages   = data.total_pages   || 1;
    renderMovies(movies, 1, totalResults, escapeHtml(label));
  } catch (err) {
    showGridError();
    console.error(err);
  }
}

// Popular (default)
async function runPopular(page = 1) {
  currentPage = page;
  showGridLoading("popular movies");
  try {
    const data   = await tmdbPopular(page);
    const movies = data.results || [];
    totalResults = data.total_results || 0;
    totalPages   = data.total_pages  || 1;
    renderMovies(movies, page, totalResults, "Popular Films");
  } catch (err) {
    showGridError();
    console.error(err);
  }
}

// Load more (appends to grid)
function loadMore() {
  const nextPage = currentPage + 1;
  currentPage    = nextPage;

  if (currentMode === "search")  runSearch(currentQuery, nextPage);
  else if (currentMode === "genre")  runGenreSearch(currentGenreId, document.getElementById("genreFilter").value, nextPage);
  else if (currentMode === "person") runPersonSearch(currentPersonId, document.getElementById("actorFilter").value || document.getElementById("actressFilter").value, nextPage);
  else runPopular(nextPage);
}

// ============================================================
//  GRID HELPERS
// ============================================================
function showGridLoading(label) {
  const grid = document.getElementById("moviesGrid");
  const meta = document.getElementById("resultsMeta");
  if (currentPage === 1 || currentPage === undefined) {
    // Render 12 skeleton cards
    grid.innerHTML = Array.from({length: 12}).map(() => `
      <div class="skeleton-card">
        <div class="skeleton-poster shimmer"></div>
        <div class="skeleton-info">
          <div class="skeleton-title shimmer"></div>
          <div class="skeleton-meta shimmer"></div>
        </div>
      </div>`).join("");
    document.getElementById("loadMoreWrap").style.display = "none";
    meta.innerHTML = "";
  }
}

function showGridError() {
  document.getElementById("moviesGrid").innerHTML = `
    <div class="no-results">
      <h3>Something went wrong</h3>
      <p>Check your TMDB API key in config.local.js or your network connection.</p>
    </div>`;
}

function renderMovies(movies, page, total, label) {
  const grid = document.getElementById("moviesGrid");
  const meta = document.getElementById("resultsMeta");
  const loadMoreWrap = document.getElementById("loadMoreWrap");

  if (!movies.length && page === 1) {
    grid.innerHTML = `<div class="no-results"><h3>No films found</h3><p>Try a different search term or filter.</p></div>`;
    return;
  }

  if (page === 1) {
    grid.innerHTML = "";
    meta.innerHTML = `Found <strong>${total.toLocaleString()}</strong> results for ${label}`;
  }

  movies.forEach((movie, i) => {
    const card = buildMovieCard(movie, i);
    grid.appendChild(card);
  });

  // Load more button
  const shown = (page - 1) * 20 + movies.length;
  if (shown < total && totalPages > page) {
    loadMoreWrap.style.display = "block";
  } else {
    loadMoreWrap.style.display = "none";
  }
}

// ============================================================
//  MOVIE CARD BUILDER  (TMDB data shape)
// ============================================================
function buildMovieCard(movie, index) {
  const card = document.createElement("div");
  card.className = "movie-card";
  card.style.animationDelay = `${index * 0.05}s`;
  card.onclick = () => openModal(movie.id, movie._isTV || false);

  const posterUrl = movie.poster_path
    ? `${TMDB_IMG}${movie.poster_path}`
    : null;

  const poster = posterUrl
    ? `<img class="card-poster" src="${posterUrl}" alt="${escapeHtml(movie.title)}" loading="lazy"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
       <div class="card-poster-placeholder" style="display:none"><span>🎬</span><small>No Poster</small></div>`
    : `<div class="card-poster-placeholder"><span>🎬</span><small>No Poster</small></div>`;

  const rating = movie.vote_average
    ? `<span class="card-rating">⭐ ${movie.vote_average.toFixed(1)}</span>` : "";
  const year   = movie.release_date
    ? `<span class="card-year">${movie.release_date.slice(0, 4)}</span>` : "";
  const typeBadge = movie._isTV
    ? `<span class="card-tv-badge">📺 Series</span>` : "";

  const inWl = isInWatchlist(movie.id);
  const movieJson = JSON.stringify({
    id: movie.id, title: movie.title,
    poster_path: movie.poster_path,
    vote_average: movie.vote_average,
    release_date: movie.release_date
  }).replace(/"/g, '&quot;');

  card.innerHTML = `
    ${poster}
    <button class="heart-btn ${inWl ? 'active' : ''}"
      data-id="${movie.id}"
      title="${inWl ? 'Remove from Watchlist' : 'Add to Watchlist'}"
      onclick="toggleWatchlist(${movie.id}, JSON.parse(this.dataset.movie), event)"
      data-movie="${movieJson}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    </button>
    <div class="card-info">
      <div class="card-title">${escapeHtml(movie.title || "Untitled")}</div>
      <div class="card-meta">${year}${rating}${typeBadge}</div>
      <div class="card-stars" id="card-stars-${movie.id}">
        ${[1,2,3,4,5].map(i => `<button class="star-btn" data-value="${i}" data-movie-id="${movie.id}" data-movie-title="${movie.title || ''}" onclick="rateMovie(${movie.id}, this.dataset.movieTitle, ${i}); event.stopPropagation()" title="Rate ${i} star">★</button>`).join('')}
      </div>
    </div>
    <div class="card-overlay">
      <div class="card-overlay-btn">View Details</div>
    </div>`;

  // Load user rating for this card asynchronously
  getUserRating(movie.id).then(userRating => {
    document.querySelectorAll(`#card-stars-${movie.id} .star-btn`).forEach(btn => {
      btn.classList.toggle("active", parseInt(btn.dataset.value) <= userRating);
    });
  });

  return card;
}

// ============================================================
//  MODAL  (TMDB detailed data + OTT Watch Providers)
// ============================================================
async function openModal(movieId, isTV = false) {
  const modal = document.getElementById("movieModal");
  const inner = document.getElementById("modalInner");

  inner.innerHTML = `<div style="padding:3rem;text-align:center;width:100%">
    <div class="reel-loader"><div class="reel"></div><div class="reel"></div><div class="reel"></div></div>
    <p style="color:var(--text-dim);margin-top:1rem">Loading…</p></div>`;
  modal.classList.add("active");
  document.body.style.overflow = "hidden";

  try {
    const base = isTV ? "tv" : "movie";
    // Fetch details, watch providers, trailer and similar in parallel
    const [m, providerData, trailerKey, similarData] = await Promise.all([
      isTV ? tmdbGetTVById(movieId) : tmdbGetById(movieId),
      fetch(`${TMDB_BASE}/${base}/${movieId}/watch/providers?api_key=${TMDB_API_KEY}`).then(r=>r.json()),
      fetch(`${TMDB_BASE}/${base}/${movieId}/videos?api_key=${TMDB_API_KEY}`).then(r=>r.json()).then(d => {
        const vids = d.results || [];
        const t = vids.find(v=>v.site==="YouTube"&&v.type==="Trailer")
               || vids.find(v=>v.site==="YouTube"&&v.type==="Teaser")
               || vids.find(v=>v.site==="YouTube");
        return t ? t.key : null;
      }),
      fetch(`${TMDB_BASE}/${base}/${movieId}/similar?api_key=${TMDB_API_KEY}`).then(r=>r.json())
    ]);
    if (m.status_message) throw new Error(m.status_message);

    // Normalize TV fields to movie-like fields
    if (isTV) {
      m.title        = m.name || m.title;
      m.release_date = m.first_air_date || m.release_date;
      m.runtime      = m.episode_run_time?.[0] || null;
    }

    // Poster
    const posterUrl = m.poster_path ? `${TMDB_IMG_LG}${m.poster_path}` : null;
    const poster = posterUrl
      ? `<div class="modal-poster-wrap"><img class="modal-poster" src="${posterUrl}" alt="${escapeHtml(m.title)}"/></div>`
      : `<div class="modal-poster-wrap"><div class="modal-poster-placeholder"><span style="font-size:3rem">🎬</span><small>No Poster</small></div></div>`;

    // Stats
    const stats = [];
    if (m.vote_average) stats.push(`<div class="modal-stat"><div class="modal-stat-val">⭐ ${m.vote_average.toFixed(1)}</div><div class="modal-stat-label">TMDb</div></div>`);
    if (m.runtime)      stats.push(`<div class="modal-stat"><div class="modal-stat-val">⏱ ${m.runtime}m</div><div class="modal-stat-label">Runtime</div></div>`);
    if (m.vote_count)   stats.push(`<div class="modal-stat"><div class="modal-stat-val">🗳 ${m.vote_count.toLocaleString()}</div><div class="modal-stat-label">Votes</div></div>`);

    // Credits
    const director = m.credits?.crew?.find(c => c.job === "Director");
    const cast   = m.credits?.cast?.slice(0, 5).map(a => a.name).join(", ");
    const genres = m.genres?.map(g => g.name).join(", ");
    const year   = m.release_date ? m.release_date.slice(0, 4) : "";
    const cert   = m.release_dates?.results?.find(r => r.iso_3166_1 === "US")
                     ?.release_dates?.find(r => r.certification)?.certification;

    // OTT Watch Providers
    // Try IN (India) first, fallback to US, then any available country
    const results = providerData.results || {};
    const regionData = results["IN"] || results["US"] || Object.values(results)[0] || null;
    const ottHtml = buildOttSection(regionData);

    // Build similar movies section
    const similarMovies = (similarData.results || []).slice(0, 6);
    const similarHtml = similarMovies.length
      ? `<div class="similar-section">
          <div class="similar-label">🎥 More Like This</div>
          <div class="similar-grid">
            ${similarMovies.map(sm => {
              const sp = sm.poster_path ? `${TMDB_IMG}${sm.poster_path}` : null;
              const sr = sm.vote_average ? sm.vote_average.toFixed(1) : "";
              const sy = sm.release_date ? sm.release_date.slice(0,4) : "";
              return `<div class="similar-card" onclick="openModal(${sm.id})">
                ${sp
                  ? `<img src="${sp}" alt="${escapeHtml(sm.title)}" loading="lazy"/>`
                  : `<div class="similar-no-poster">🎬</div>`}
                <div class="similar-info">
                  <div class="similar-title">${escapeHtml(sm.title)}</div>
                  <div class="similar-meta">${sy}${sr ? " · ⭐" + sr : ""}</div>
                </div>
              </div>`;
            }).join("")}
          </div>
        </div>`
      : "";

    // Build trailer section HTML
    const trailerHtml = trailerKey
      ? `<div class="trailer-wrap">
          <div class="trailer-thumb" onclick="playTrailer(this, '${trailerKey}')"
               style="background-image:url('https://img.youtube.com/vi/${trailerKey}/hqdefault.jpg')">
            <div class="trailer-play-btn">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </div>
            <div class="trailer-label">▶ Watch Trailer</div>
          </div>
        </div>`
      : "";

    inner.innerHTML = `
      ${poster}
      <div class="modal-body">
        ${genres ? `<div class="modal-genre-tag">${escapeHtml(genres.split(",")[0].trim())}</div>` : ""}
        <h2 class="modal-title">${escapeHtml(m.title)}</h2>
        <div class="modal-year">${year}${cert ? " · " + cert : ""}${m.original_language !== "en" ? " · " + m.original_language.toUpperCase() : ""}</div>
        ${stats.length ? `<div class="modal-stats">${stats.join("")}</div>` : ""}
        ${m.overview ? `<div class="modal-plot">${escapeHtml(m.overview)}</div>` : ""}
        <div class="modal-rating-section">
          <div class="modal-rating-label">⭐ Rate this ${isTV ? "show" : "movie"}</div>
          <div class="modal-stars" id="modal-stars-${m.id || movieId}">
            ${[1,2,3,4,5].map(i => `<button class="star-btn modal-star-btn" data-value="${i}" data-movie-id="${movieId}" data-movie-title="${escapeHtml(m.title)}" onclick="rateMovie(${movieId}, this.dataset.movieTitle, ${i})" title="Rate ${i} star">★</button>`).join("")}
          </div>
          <div class="modal-avg-rating" id="avg-rating-${movieId}">Loading ratings...</div>
        </div>
        ${trailerHtml}
        ${ottHtml}
        <div class="modal-info">
          ${director ? `<div><strong>Director:</strong> ${escapeHtml(director.name)}</div>` : ""}
          ${cast     ? `<div><strong>Cast:</strong> ${escapeHtml(cast)}</div>` : ""}
          ${genres   ? `<div><strong>Genres:</strong> ${escapeHtml(genres)}</div>` : ""}
          ${m.production_countries?.length ? `<div><strong>Country:</strong> ${escapeHtml(m.production_countries.map(c => c.name).join(", "))}</div>` : ""}
          ${m.budget  ? `<div><strong>Budget:</strong> $${m.budget.toLocaleString()}</div>` : ""}
          ${m.revenue ? `<div><strong>Revenue:</strong> $${m.revenue.toLocaleString()}</div>` : ""}
          ${m.tagline ? `<div><strong>Tagline:</strong> <em>${escapeHtml(m.tagline)}</em></div>` : ""}
          ${isTV && m.number_of_seasons ? `<div><strong>Seasons:</strong> ${m.number_of_seasons}</div>` : ""}
          ${isTV && m.number_of_episodes ? `<div><strong>Episodes:</strong> ${m.number_of_episodes}</div>` : ""}
          ${isTV && m.networks?.length ? `<div><strong>Network:</strong> ${escapeHtml(m.networks.map(n=>n.name).join(", "))}</div>` : ""}
          ${isTV && m.status ? `<div><strong>Status:</strong> ${escapeHtml(m.status)}</div>` : ""}
        </div>
        ${similarHtml}
      </div>`;
    // Load user rating and avg rating for modal
    getUserRating(movieId).then(userRating => {
      document.querySelectorAll(`#modal-stars-${movieId} .star-btn`).forEach(btn => {
        btn.classList.toggle("active", parseInt(btn.dataset.value) <= userRating);
      });
    });
    loadMovieAvgRating(movieId);

  } catch (e) {
    inner.innerHTML = `<div style="padding:2rem;color:var(--text-dim);text-align:center;width:100%">Could not load movie details.</div>`;
  }
}

// Fetch OTT watch providers from TMDB
async function tmdbGetWatchProviders(movieId) {
  const url = `${TMDB_BASE}/movie/${movieId}/watch/providers?api_key=${TMDB_API_KEY}`;
  const res = await fetch(url);
  return res.json();
}

// Fetch trailer from TMDB
async function tmdbGetTrailer(movieId) {
  const url = `${TMDB_BASE}/movie/${movieId}/videos?api_key=${TMDB_API_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();
  // Prefer official YouTube trailer, fallback to any teaser/clip
  const videos = data.results || [];
  const trailer = videos.find(v => v.site === "YouTube" && v.type === "Trailer")
    || videos.find(v => v.site === "YouTube" && v.type === "Teaser")
    || videos.find(v => v.site === "YouTube");
  return trailer ? trailer.key : null;
}

// Fetch similar movies from TMDB
async function tmdbGetSimilar(movieId) {
  const url = `${TMDB_BASE}/movie/${movieId}/similar?api_key=${TMDB_API_KEY}&page=1`;
  const res  = await fetch(url);
  return res.json();
}

// Build the OTT section HTML
function buildOttSection(regionData) {
  if (!regionData) {
    return `<div class="ott-section">
      <div class="ott-label">Where to Watch</div>
      <div class="ott-unavailable">Not available on streaming platforms in your region.</div>
    </div>`;
  }

  const { flatrate, rent, buy, link } = regionData;
  let html = `<div class="ott-section"><div class="ott-label">🍿 Where to Watch</div>`;

  if (flatrate?.length) {
    html += `<div class="ott-group-label">Stream</div><div class="ott-providers">`;
    flatrate.forEach(p => {
      html += `<div class="ott-provider" title="${escapeHtml(p.provider_name)}">
        <img src="https://image.tmdb.org/t/p/original${p.logo_path}" alt="${escapeHtml(p.provider_name)}" />
        <span>${escapeHtml(p.provider_name)}</span>
      </div>`;
    });
    html += `</div>`;
  }

  if (rent?.length) {
    html += `<div class="ott-group-label">Rent</div><div class="ott-providers">`;
    rent.slice(0, 4).forEach(p => {
      html += `<div class="ott-provider" title="${escapeHtml(p.provider_name)}">
        <img src="https://image.tmdb.org/t/p/original${p.logo_path}" alt="${escapeHtml(p.provider_name)}" />
        <span>${escapeHtml(p.provider_name)}</span>
      </div>`;
    });
    html += `</div>`;
  }

  if (buy?.length && !rent?.length) {
    html += `<div class="ott-group-label">Buy</div><div class="ott-providers">`;
    buy.slice(0, 4).forEach(p => {
      html += `<div class="ott-provider" title="${escapeHtml(p.provider_name)}">
        <img src="https://image.tmdb.org/t/p/original${p.logo_path}" alt="${escapeHtml(p.provider_name)}" />
        <span>${escapeHtml(p.provider_name)}</span>
      </div>`;
    });
    html += `</div>`;
  }

  if (!flatrate?.length && !rent?.length && !buy?.length) {
    html += `<div class="ott-unavailable">Not available on streaming platforms right now.</div>`;
  }

  if (link) {
    html += `<a class="ott-tmdb-link" href="${link}" target="_blank" rel="noopener">
      View all options on TMDb ↗
    </a>`;
  }

  html += `</div>`;
  return html;
}

// Play trailer inline by replacing thumbnail with iframe
function playTrailer(el, key) {
  el.innerHTML = `<iframe
    src="https://www.youtube.com/embed/${key}?autoplay=1&rel=0"
    frameborder="0"
    allow="autoplay; encrypted-media; fullscreen"
    allowfullscreen
    style="width:100%;height:100%;border-radius:10px;display:block;">
  </iframe>`;
  el.style.backgroundImage = "none";
  el.style.cursor = "default";
  el.onclick = null;
}

function closeModal(event) {
  if (event && event.target !== document.getElementById("movieModal") &&
      !event.target.classList.contains("modal-close")) return;
  document.getElementById("movieModal").classList.remove("active");
  document.body.style.overflow = "";
}

// ============================================================
//  TRENDING  (TMDB has a real /trending endpoint!)
// ============================================================
async function loadTrending() {
  const grid = document.getElementById("trendingGrid");
  grid.innerHTML = Array.from({length: 10}).map(() => `
    <div class="skeleton-card">
      <div class="skeleton-poster shimmer"></div>
      <div class="skeleton-info">
        <div class="skeleton-title shimmer"></div>
        <div class="skeleton-meta shimmer"></div>
      </div>
    </div>`).join("");
  try {
    // Fetch both trending movies AND TV in parallel
    const [moviesData, tvData] = await Promise.all([
      tmdbTrending(),
      tmdbTrendingTV()
    ]);
    const movies = (moviesData.results || []).slice(0, 5);
    const shows  = (tvData.results   || []).slice(0, 5).map(normalizeTV);
    // Interleave: movie, show, movie, show...
    const combined = [];
    for (let i = 0; i < 5; i++) {
      if (movies[i]) combined.push(movies[i]);
      if (shows[i])  combined.push(shows[i]);
    }
    grid.innerHTML = "";
    combined.forEach((item, i) => {
      const card = buildMovieCard(item, i);
      grid.appendChild(card);
    });
    if (!grid.children.length) throw new Error("empty");
  } catch (e) {
    grid.innerHTML = `<div class="no-results"><h3>Could not load trending</h3><p>Check your TMDB API key.</p></div>`;
  }
}

// ============================================================
//  AI CHATBOT  (Groq API via Netlify Function — key hidden server-side ✅)
// ============================================================
const GROQ_URL = "/.netlify/functions/chat";  // ✅ calls our serverless function, not Groq directly

const SYSTEM_PROMPT = `You are CineBot — a warm, knowledgeable, and passionate movie recommendation AI assistant for the CineVerse website.

You help cinema lovers discover films based on:
- Genre preferences (action, drama, horror, romance, comedy, thriller, sci-fi, etc.)
- Favourite actors/heroes (e.g. Tom Hanks, Shah Rukh Khan, Meryl Streep, Amitabh Bachchan)
- Favourite actresses/heroines (e.g. Deepika Padukone, Cate Blanchett, Natalie Portman)
- Character types (superhero, villain, detective, warrior, anti-hero, spy, romantic lead)
- Mood or theme (uplifting, dark, mysterious, feel-good, intense)
- Era or decade (classic 90s, 2000s hits, recent blockbusters)
- Regional cinema (Bollywood, Hollywood, Tamil, Telugu, Korean, French, etc.)
- Similarity to other films (e.g. "like Inception" or "similar to RRR")

When recommending movies:
1. Always give 3-6 specific movie recommendations with their year.
2. Include a brief, exciting reason why each is recommended.
3. Mention the lead actor/actress when relevant.
4. Use emojis tastefully to make responses engaging.
5. If the user mentions a specific actor, actress, or character type, focus on those.
6. For Indian cinema fans, include relevant Bollywood/regional recommendations when suitable.
7. Keep responses concise but enthusiastic — you love movies!

Format each recommendation like:
🎬 **Movie Title (Year)** — One-line reason.

Always end with a question to learn more about what they want.`;

async function sendChat() {
  const input = document.getElementById("chatInput");
  const msg   = input.value.trim();
  if (!msg) return;

  input.value = "";
  hideSuggestions();
  appendMessage("user", msg);

  chatHistory.push({ role: "user", content: msg });

  const loadingId = appendMessage("bot", "Thinking… 🎬", true);

  try {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...chatHistory
    ];

    // ✅ Calls Netlify Function — Groq key stays server-side, never exposed
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages })
    });

    const data = await response.json();

    if (data.error) throw new Error(data.error.message || "Groq API error");

    const reply = data.choices?.[0]?.message?.content
      || "Sorry, I couldn\'t get a response. Please try again!";

    removeMessage(loadingId);
    chatHistory.push({ role: "assistant", content: reply });
    appendMessage("bot", formatBotMessage(reply));

  } catch (err) {
    removeMessage(loadingId);
    if (err.message && err.message.includes("401")) {
      appendMessage("bot", "⚠️ Invalid Groq API key. Please check <strong>GROQ_API_KEY</strong> in config.local.js.");
    } else {
      appendMessage("bot", `⚠️ Error: ${err.message}. Open F12 Console for details.`);
    }
    console.error("Groq error:", err);
  }
}

function sendSuggestion(btn) {
  document.getElementById("chatInput").value = btn.textContent.replace(/^[^\s]+\s/, "").trim();
  sendChat();
}

function appendMessage(role, html, isLoading = false) {
  const container = document.getElementById("chatMessages");
  const id = "msg_" + Date.now() + Math.random().toString(36).slice(2);
  const avatarEmoji = role === "bot" ? "🎥" : "🧑";
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  div.id = id;
  div.innerHTML = `
    <div class="msg-avatar">${avatarEmoji}</div>
    <div class="msg-bubble ${isLoading ? "loading" : ""}">${html}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

function removeMessage(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function hideSuggestions() {
  const s = document.getElementById("chatSuggestions");
  if (s) s.style.display = "none";
}

function formatBotMessage(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br/>");
}

// ============================================================
//  NAVBAR ACTIVE LINK ON SCROLL
// ============================================================
function updateNavLinks() {
  const sections = ["home", "discover", "trending", "chatbot-section"];
  const links    = document.querySelectorAll(".nav-link");
  let current = "";
  sections.forEach(id => {
    const el = document.getElementById(id);
    if (el && window.scrollY >= el.offsetTop - 100) current = id;
  });
  links.forEach(link => {
    link.classList.toggle("active", link.getAttribute("href") === "#" + current);
  });
}
window.addEventListener("scroll", updateNavLinks, { passive: true });


// ============================================================
//  WATCHLIST  (localStorage)
// ============================================================
function getWatchlist() {
  return JSON.parse(localStorage.getItem("cineverse_watchlist") || "[]");
}

function saveWatchlist(list) {
  localStorage.setItem("cineverse_watchlist", JSON.stringify(list));
  updateWlCount();
  saveWatchlistToFirestore(list); // sync to cloud if logged in
}

function updateWlCount() {
  const count = getWatchlist().length;
  const badge = document.getElementById("wlCount");
  if (!badge) return;
  badge.textContent = count;
  badge.style.display = count === 0 ? "none" : "flex";
  badge.classList.remove("bump");
  void badge.offsetWidth; // reflow for animation
  badge.classList.add("bump");
}

function isInWatchlist(movieId) {
  return getWatchlist().some(m => m.id === movieId);
}

function toggleWatchlist(movieId, movie, event) {
  event.stopPropagation(); // prevent modal opening
  const list = getWatchlist();
  const idx  = list.findIndex(m => m.id === movieId);

  if (idx === -1) {
    list.push({
      id:           movie.id,
      title:        movie.title,
      poster_path:  movie.poster_path,
      vote_average: movie.vote_average,
      release_date: movie.release_date,
    });
    saveWatchlist(list);
    showToast(`❤️ Added "${movie.title}" to Watchlist`);
  } else {
    list.splice(idx, 1);
    saveWatchlist(list);
    showToast(`💔 Removed "${movie.title}" from Watchlist`);
  }

  // Update all heart buttons for this movie on the page
  document.querySelectorAll(`.heart-btn[data-id="${movieId}"]`).forEach(btn => {
    btn.classList.toggle("active", idx === -1);
    btn.title = idx === -1 ? "Remove from Watchlist" : "Add to Watchlist";
    btn.classList.remove("pop");
    void btn.offsetWidth;
    btn.classList.add("pop");
  });

  // If watchlist panel is open, refresh it
  if (document.getElementById("watchlistPanel").classList.contains("open")) {
    renderWatchlistPanel();
  }
}

function renderWatchlistPanel() {
  const list = getWatchlist();
  const grid = document.getElementById("watchlistGrid");

  if (!list.length) {
    grid.innerHTML = `<div class="wl-empty">
      <span>🎬</span>
      <p>Your watchlist is empty.</p>
      <small>Tap the ❤️ on any movie to save it here.</small>
    </div>`;
    return;
  }

  grid.innerHTML = "";
  list.forEach((movie, i) => {
    const card = buildMovieCard(movie, i);
    grid.appendChild(card);
  });
}

function openWatchlistPanel() {
  renderWatchlistPanel();
  document.getElementById("watchlistPanel").classList.add("open");
  document.getElementById("watchlistOverlay").classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeWatchlistPanel() {
  document.getElementById("watchlistPanel").classList.remove("open");
  document.getElementById("watchlistOverlay").classList.remove("active");
  document.body.style.overflow = "";
}

// ============================================================
//  RATINGS PANEL
// ============================================================
async function openRatingsPanel() {
  if (!currentUser) {
    showToast("⚠️ Please sign in to view your ratings!");
    document.getElementById("loginModal").classList.add("active");
    return;
  }
  document.getElementById("ratingsPanel").classList.add("open");
  document.getElementById("ratingsOverlay").classList.add("active");
  document.body.style.overflow = "hidden";
  await renderRatingsPanel();
}

function closeRatingsPanel() {
  document.getElementById("ratingsPanel").classList.remove("open");
  document.getElementById("ratingsOverlay").classList.remove("active");
  document.body.style.overflow = "";
}

async function renderRatingsPanel() {
  const grid = document.getElementById("ratingsGrid");
  grid.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--text-dim)">Loading your ratings...</div>`;

  try {
    const snapshot = await db.collection("ratings")
      .where("userId", "==", currentUser.uid)
      .get();

    if (snapshot.empty) {
      grid.innerHTML = `<div class="wl-empty">
        <span>⭐</span>
        <p>You haven't rated anything yet.</p>
        <small>Open any movie and give it a star rating!</small>
      </div>`;
      return;
    }

    // Get all rated movies
    const rated = [];
    snapshot.forEach(doc => rated.push(doc.data()));

    // Sort by most recently rated
    rated.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));

    grid.innerHTML = "";
    rated.forEach((item, i) => {
      const card = document.createElement("div");
      card.className = "movie-card";
      card.style.animationDelay = `${i * 0.05}s`;
      card.onclick = () => openModal(item.movieId);

      // Build stars display
      const stars = [1,2,3,4,5].map(s =>
        `<span style="color:${s <= item.rating ? 'var(--gold)' : 'var(--border)'}">★</span>`
      ).join("");

      card.innerHTML = `
        <div class="card-poster-placeholder" style="height:200px">
          <span style="font-size:3rem">🎬</span>
          <small style="margin-top:0.5rem;color:var(--text-dim)">${escapeHtml(item.movieTitle || "Unknown")}</small>
        </div>
        <div class="card-info">
          <div class="card-title">${escapeHtml(item.movieTitle || "Unknown")}</div>
          <div style="font-size:1.1rem;margin-top:0.3rem">${stars}</div>
          <div style="font-size:0.75rem;color:var(--text-dim);margin-top:0.2rem">Your rating: ${item.rating}/5</div>
        </div>`;

      grid.appendChild(card);
    });

  } catch (e) {
    console.error("Ratings panel error:", e);
    grid.innerHTML = `<div class="wl-empty"><span>⚠️</span><p>Could not load ratings.</p></div>`;
  }
}

// Toast notification
function showToast(message) {
  const existing = document.getElementById("toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = "toast";
  toast.className = "toast";
  toast.innerHTML = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("show"), 10);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 400);
  }, 2800);
}

// ============================================================
//  UTILITY
// ============================================================
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
//  INIT
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  runPopular(1);
  loadTrending();
  updateWlCount();
  document.getElementById("heroSearch").addEventListener("keydown", e => {
    if (e.key === "Enter") heroSearch();
  });
});