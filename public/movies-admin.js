(() => {
  const byId = (id) => document.getElementById(id);
  const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);

  async function requestJson(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    let result = {};
    try {
      result = await response.json();
    } catch (error) {
      if (response.ok) throw new Error('The server returned an invalid response.');
    }

    if (response.status === 401 || response.status === 403) {
      window.location.href = '/account.html';
      throw new Error('Admin sign-in is required.');
    }
    if (!response.ok) {
      throw new Error(result.message || `Request failed with status ${response.status}.`);
    }
    return result;
  }

  async function upload(file, type) {
    const message = byId('upMsg');
    const button = byId(type === 'media' ? 'uVideo' : 'uPoster');
    if (file.size > MAX_UPLOAD_BYTES) {
      message.textContent = 'Uploads must be smaller than 2 GB.';
      return null;
    }

    button.disabled = true;
    message.textContent = `Uploading ${type} (${(file.size / (1024 * 1024)).toFixed(1)} MB)…`;
    try {
      const result = await requestJson(`/api/admin/movies/media?type=${encodeURIComponent(type)}`, {
        method: 'POST',
        headers: {
          'X-Movie-Filename': file.name.replace(/[\r\n]/g, ''),
          'Content-Type': 'application/octet-stream'
        },
        body: file
      });
      message.textContent = `Uploaded ${result.filename}.`;
      return result.assetUrl;
    } catch (error) {
      console.error(`Movie ${type} upload failed:`, error);
      message.textContent = `${error.message} If this continues, check Render logs and storage.`;
      return null;
    } finally {
      button.disabled = false;
    }
  }

  async function loadMovies() {
    try {
      const result = await requestJson('/api/admin/movies');
      const movies = result.movies || [];
      byId('count').textContent = movies.length;
      byId('list').innerHTML = movies.map((movie) => `
        <div class="m">
          <img src="${escapeHtml(movie.posterUrl || '/assets/movie-poster-fallback.svg')}" alt="">
          <div style="flex:1">
            <b>${escapeHtml(movie.title)}</b>
            <span class="pill ${movie.access === 'premium' ? 'p' : ''}">${escapeHtml(movie.access)}</span>
            <span class="pill">${escapeHtml(movie.status)}</span>
            ${movie.featured ? '<span class="pill p">FEATURED</span>' : ''}
            <div class="small">${escapeHtml(movie.id)} · ${escapeHtml(movie.genres || '')} · ${escapeHtml(movie.mediaUrl || '')}</div>
            <div class="small">${escapeHtml(movie.license?.name || '')} · ${escapeHtml(movie.license?.attribution || '')}</div>
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
              <button type="button" data-action="feature" data-id="${escapeHtml(movie.id)}" data-value="${movie.featured ? 'true' : 'false'}">${movie.featured ? 'Unfeature' : 'Feature'}</button>
              <button type="button" data-action="access" data-id="${escapeHtml(movie.id)}" data-value="${escapeHtml(movie.access)}">Make ${movie.access === 'premium' ? 'Free' : 'Premium'}</button>
              <button type="button" data-action="delete" data-id="${escapeHtml(movie.id)}">Delete</button>
              <a href="/play.html?mId=${encodeURIComponent(movie.id)}">Play</a>
            </div>
          </div>
        </div>`).join('') || 'No movies yet.';
    } catch (error) {
      console.error('Could not load movie catalog:', error);
      byId('list').textContent = error.message;
    }
  }

  async function showStorage() {
    try {
      const result = await requestJson('/api/admin/movies/storage');
      const count = `${result.fileCount} file(s), ${result.totalMb} MB`;
      byId('storageMsg').textContent = result.warning
        ? `${count}. ${result.warning}`
        : `${count}. Persistent movie storage is configured.`;
    } catch (error) {
      console.error('Could not read movie storage status:', error);
      byId('storageMsg').textContent = `Could not read upload storage: ${error.message}`;
    }
  }

  byId('uVideo').addEventListener('click', async () => {
    const file = byId('fVideo').files[0];
    if (!file) {
      byId('upMsg').textContent = 'Choose a video file first.';
      return;
    }
    const assetUrl = await upload(file, 'media');
    if (assetUrl) byId('mediaUrl').value = assetUrl;
  });

  byId('uPoster').addEventListener('click', async () => {
    const file = byId('fPoster').files[0];
    if (!file) {
      byId('upMsg').textContent = 'Choose a poster image first.';
      return;
    }
    const assetUrl = await upload(file, 'poster');
    if (assetUrl) byId('posterUrl').value = assetUrl;
  });

  byId('publish').addEventListener('click', async () => {
    const message = byId('msg');
    const payload = {
      title: byId('title').value.trim(),
      year: Number(byId('year').value),
      runtime: byId('runtime').value.trim(),
      description: byId('desc').value.trim(),
      genres: byId('genres').value.trim(),
      access: byId('access').value,
      status: byId('status').value,
      featured: byId('featured').value,
      subtitlesLanguage: byId('subLang').value.trim(),
      mediaUrl: byId('mediaUrl').value.trim(),
      posterUrl: byId('posterUrl').value.trim() || null,
      licenseName: byId('licenseName').value.trim(),
      licenseUrl: byId('licenseUrl').value.trim(),
      attribution: byId('attribution').value.trim()
    };

    if (Object.entries(payload).some(([key, value]) => ['title', 'runtime', 'description', 'genres', 'mediaUrl', 'licenseName', 'licenseUrl', 'attribution'].includes(key) && !value)) {
      message.textContent = 'Complete all required movie and license fields before publishing.';
      return;
    }
    try {
      const licenseUrl = new URL(payload.licenseUrl);
      if (!['http:', 'https:'].includes(licenseUrl.protocol)) throw new Error('License URL must use HTTP or HTTPS.');
    } catch (error) {
      message.textContent = error.message === 'Invalid URL' ? 'Enter a valid HTTP(S) license URL.' : error.message;
      return;
    }

    const button = byId('publish');
    button.disabled = true;
    message.textContent = 'Publishing movie…';
    try {
      const result = await requestJson('/api/admin/movies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      message.textContent = `Published ${result.movie.title}.`;
      byId('title').value = '';
      byId('desc').value = '';
      byId('mediaUrl').value = '';
      byId('posterUrl').value = '';
      byId('licenseName').value = '';
      byId('licenseUrl').value = '';
      byId('attribution').value = '';
      byId('fVideo').value = '';
      byId('fPoster').value = '';
      await loadMovies();
    } catch (error) {
      console.error('Movie publish failed:', error);
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  byId('list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, id, value } = button.dataset;
    try {
      if (action === 'delete') {
        if (!window.confirm('Delete this movie and its catalog entry?')) return;
        await requestJson(`/api/admin/movies/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } else {
        const body = action === 'feature'
          ? { featured: value !== 'true' }
          : { access: value === 'premium' ? 'free' : 'premium' };
        await requestJson(`/api/admin/movies/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      }
      await loadMovies();
    } catch (error) {
      console.error('Movie update failed:', error);
      byId('msg').textContent = error.message;
    }
  });

  loadMovies();
  showStorage();
})();
