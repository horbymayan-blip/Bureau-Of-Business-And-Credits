#!/usr/bin/env node
/**
 * Seed script: preloads a handful of cartoon titles into the local catalog
 * so the movie section can be tested without uploading real video files.
 *
 * Safe to re-run: any cartoon IDs that already exist are skipped.
 */

'use strict';

const database = require('../database');

const cartoons = [
  {
    id: 'cartoon-tomjerry',
    title: 'Tom & Jerry',
    year: 1940,
    runtime: '22m 00s',
    description: 'Classic slapstick duo chasing each other through a never-ending house full of chaos, zany pranks and near-miss cat-and-mouse gags.',
    genres: 'Animation, Comedy',
    access: 'free',
    status: 'published',
    featured: 0,
    subtitlesLanguage: 'en',
    mediaUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
    posterUrl: '/assets/alternative.jpg',
    subtitlesUrl: null,
    license: { name: 'Creative Commons Attribution 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Public demo — replace with licensed assets' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'cartoon-spongebob',
    title: 'SpongeBob SquarePants',
    year: 2000,
    runtime: '22m 00s',
    description: 'Underwater comedy about a bright yellow sea sponge who works at the Krusty Krab and gets into wacky, fast-paced adventures with his sea-floor friends.',
    genres: 'Animation, Comedy',
    access: 'free',
    status: 'published',
    featured: 0,
    subtitlesLanguage: 'en',
    mediaUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
    posterUrl: '/assets/alternative.jpg',
    subtitlesUrl: null,
    license: { name: 'Creative Commons Attribution 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Public demo — replace with licensed assets' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'cartoon-simpsons',
    title: 'The Simpsons',
    year: 1989,
    runtime: '24m 00s',
    description: 'Family sitcom set in the fictional town of Springfield, following the misadventures of the Simpson family and their next-door neighbours.',
    genres: 'Animation, Sitcom',
    access: 'free',
    status: 'published',
    featured: 0,
    subtitlesLanguage: 'en',
    mediaUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
    posterUrl: '/assets/alternative.jpg',
    subtitlesUrl: null,
    license: { name: 'Creative Commons Attribution 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Public demo — replace with licensed assets' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'cartoon-looney',
    title: 'Looney Tunes & Merrie Melodies',
    year: 1940,
    runtime: '28m 00s',
    description: 'Retro catalogue of animated short subjects packed with iconic characters, abstract humour and the classic golden-age cartoon charm.',
    genres: 'Comedy, Animation',
    access: 'free',
    status: 'published',
    featured: 0,
    subtitlesLanguage: 'en',
    mediaUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
    posterUrl: '/assets/alternative.jpg',
    subtitlesUrl: null,
    license: { name: 'Creative Commons Attribution 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Public demo — replace with licensed assets' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

(async () => {
  let added = 0;
  for (const movie of cartoons) {
    const exists = database.getMovie(movie.id);
    if (exists) {
      console.log(`Skipped (already present): ${movie.id} — ${movie.title}`);
      continue;
    }
    database.createMovie(movie);
    console.log(`Added: ${movie.title} (${movie.id})`);
    added += 1;
  }

  if (added === 0) {
    console.log('No new cartoon titles were added — the local catalog already has these IDs.');
  } else {
    console.log(`Done. ${added} cartoon title(s) added to the catalog.`);
  }
  process.exit(0);
})();
