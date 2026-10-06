// src/lib/startHere.js — the "Start here" shortlist.
//
// Titles chosen to be recognised and disagreed about, which are different
// things from "good". A visitor who has just arrived from an ad will not write
// the first review of something obscure; they will write one about something
// they already have an opinion on, and the fastest way to get that opinion out
// of them is to show them something they think everyone else is wrong about.
//
// Curated rather than computed, because nothing in the catalogue can rank
// recognisability. The only popularity signal stored is tmdbRating, which
// measures how well-liked a title is among people who sought it out — a
// beloved obscurity outranks Titanic on it. Ranking by that would produce a
// list of titles nobody arrives with an opinion about, which is the opposite
// of what this slot is for.
//
// The year is part of the key and is load-bearing: this catalogue holds
// Titanic (1953) as well as (1997), Gladiator (1992) as well as (2000), and
// Dune (1984) as well as (2021). Matching on title alone would show the wrong
// film about a third of the time here.
//
// Three rough groups, kept mixed rather than labelled, since the point is an
// opinion rather than a verdict:
//   - canonical, where the argument is whether it has aged
//   - divisive, where the argument never settled
//   - famously bad, where the argument is how bad
//
// Entries that match nothing are skipped silently, so this list can be edited
// freely without checking the catalogue first.

const START_HERE = [
  // ─── Films ───────────────────────────────────────────────────────────────
  // Canonical — the argument is whether they hold up.
  { type: 'MOVIE', title: 'The Godfather',                  year: 1972 },
  { type: 'MOVIE', title: 'Jaws',                           year: 1975 },
  { type: 'MOVIE', title: 'Alien',                          year: 1979 },
  { type: 'MOVIE', title: 'The Shining',                    year: 1980 },
  { type: 'MOVIE', title: 'Ghostbusters',                   year: 1984 },
  { type: 'MOVIE', title: 'Home Alone',                     year: 1990 },
  { type: 'MOVIE', title: 'Jurassic Park',                  year: 1993 },
  { type: 'MOVIE', title: 'Pulp Fiction',                   year: 1994 },
  { type: 'MOVIE', title: 'Forrest Gump',                   year: 1994 },
  { type: 'MOVIE', title: 'The Matrix',                     year: 1999 },
  { type: 'MOVIE', title: 'Fight Club',                     year: 1999 },
  { type: 'MOVIE', title: 'Gladiator',                      year: 2000 },
  { type: 'MOVIE', title: 'The Dark Knight',                year: 2008 },
  { type: 'MOVIE', title: 'Inception',                      year: 2010 },
  { type: 'MOVIE', title: 'Interstellar',                   year: 2014 },

  // Divisive — these are the ones that actually start arguments.
  { type: 'MOVIE', title: 'Grease',                         year: 1978 },
  { type: 'MOVIE', title: 'Titanic',                        year: 1997 },
  { type: 'MOVIE', title: 'American Beauty',                year: 1999 },
  { type: 'MOVIE', title: 'Cast Away',                      year: 2000 },
  { type: 'MOVIE', title: 'Donnie Darko',                   year: 2001 },
  { type: 'MOVIE', title: 'Love Actually',                  year: 2003 },
  { type: 'MOVIE', title: 'Napoleon Dynamite',              year: 2004 },
  { type: 'MOVIE', title: 'The Notebook',                   year: 2004 },
  { type: 'MOVIE', title: 'Eternal Sunshine of the Spotless Mind', year: 2004 },
  { type: 'MOVIE', title: 'Avatar',                         year: 2009 },
  { type: 'MOVIE', title: 'Prometheus',                     year: 2012 },
  { type: 'MOVIE', title: 'Man of Steel',                   year: 2013 },
  { type: 'MOVIE', title: 'Frozen',                         year: 2013 },
  { type: 'MOVIE', title: 'La La Land',                     year: 2016 },
  { type: 'MOVIE', title: 'Blade Runner 2049',              year: 2017 },
  { type: 'MOVIE', title: 'Bohemian Rhapsody',              year: 2018 },
  { type: 'MOVIE', title: 'Green Book',                     year: 2018 },
  { type: 'MOVIE', title: 'Joker',                          year: 2019 },
  { type: 'MOVIE', title: 'Dune',                           year: 2021 },
  { type: 'MOVIE', title: 'Top Gun: Maverick',              year: 2022 },
  { type: 'MOVIE', title: 'Barbie',                         year: 2023 },
  { type: 'MOVIE', title: 'Oppenheimer',                    year: 2023 },

  // Famously bad — the easiest opinion in the world to hold.
  { type: 'MOVIE', title: 'Batman & Robin',                 year: 1997 },
  { type: 'MOVIE', title: 'The Room',                       year: 2003 },
  { type: 'MOVIE', title: 'Spider-Man 3',                   year: 2007 },
  { type: 'MOVIE', title: 'The Last Airbender',             year: 2010 },
  { type: 'MOVIE', title: 'Suicide Squad',                  year: 2016 },
  { type: 'MOVIE', title: 'Cats',                           year: 2019 },
  { type: 'MOVIE', title: 'Morbius',                        year: 2022 },

  // ─── Television ──────────────────────────────────────────────────────────
  // The parent show row, not a season: these are whole-series opinions, and a
  // season-level argument is a different (and narrower) conversation.
  //
  // Heavily weighted toward shows whose ENDING is the argument, because that
  // is the single most reliable opinion anyone holds about television.
  { type: 'TV_SHOW', title: 'Seinfeld',              year: 1989 },
  { type: 'TV_SHOW', title: 'Twin Peaks',            year: 1990 },
  { type: 'TV_SHOW', title: 'Friends',               year: 1994 },
  { type: 'TV_SHOW', title: 'The Sopranos',          year: 1999 },  // the cut to black
  { type: 'TV_SHOW', title: 'Lost',                  year: 2004 },  // the ending
  { type: 'TV_SHOW', title: 'Battlestar Galactica',  year: 2004 },  // the ending
  { type: 'TV_SHOW', title: 'The Office',            year: 2005 },
  { type: 'TV_SHOW', title: 'How I Met Your Mother', year: 2005 },  // the ending
  { type: 'TV_SHOW', title: 'Dexter',                year: 2006 },  // the ending
  { type: 'TV_SHOW', title: 'Mad Men',               year: 2007 },
  { type: 'TV_SHOW', title: 'The Big Bang Theory',   year: 2007 },
  { type: 'TV_SHOW', title: 'Breaking Bad',          year: 2008 },
  { type: 'TV_SHOW', title: 'Sherlock',              year: 2010 },
  { type: 'TV_SHOW', title: 'The Walking Dead',      year: 2010 },
  { type: 'TV_SHOW', title: 'Game of Thrones',       year: 2011 },  // the ending
  { type: 'TV_SHOW', title: 'Stranger Things',       year: 2016 },
  { type: 'TV_SHOW', title: 'Westworld',             year: 2016 },
  { type: 'TV_SHOW', title: 'Succession',            year: 2018 },
  { type: 'TV_SHOW', title: 'Euphoria',              year: 2019 },
  { type: 'TV_SHOW', title: 'Ted Lasso',             year: 2020 },
  { type: 'TV_SHOW', title: 'Emily in Paris',        year: 2020 },
  { type: 'TV_SHOW', title: 'Severance',             year: 2022 },
  { type: 'TV_SHOW', title: 'The Last of Us',        year: 2023 },
  { type: 'TV_SHOW', title: 'Velma',                 year: 2023 },

  // ─── Books ───────────────────────────────────────────────────────────────
  // Exactly one, and deliberately one with no film adaptation — so the opinion
  // is about the book rather than about a film someone saw instead of reading
  // it. The Catcher in the Rye is the strongest candidate on every count: close
  // to universally assigned in school, genuinely divisive (Holden is either
  // profound or insufferable, and nobody is neutral), and famously never
  // adapted — Salinger refused throughout his life and his estate still does,
  // which makes "no adaptation" a fact about the book rather than an accident.
  //
  // Catch-22 was the obvious alternative and fails the test: a 1970 film and a
  // 2019 miniseries.
  { type: 'BOOK', title: 'The Catcher in the Rye',   year: 1951 },
];

module.exports = { START_HERE };
