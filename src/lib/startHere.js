// src/lib/startHere.js — the "Start here" shortlist.
//
// Films chosen to be recognised and disagreed about, which are different
// things from "good". A visitor who has just arrived from an ad will not
// write the first review of something obscure; they will write one about a
// film they already have an opinion on, and the fastest way to get that
// opinion out of them is to show them something they think everyone else is
// wrong about.
//
// Curated rather than computed, because nothing in the catalogue can rank
// recognisability. The only popularity signal stored is tmdbRating, which
// measures how well-liked a film is among people who sought it out — a
// beloved obscurity outranks Titanic on it. Ranking by that would produce a
// list of films nobody arrives with an opinion about, which is the opposite
// of what this slot is for.
//
// The year is part of the key and is load-bearing: this catalogue holds
// Titanic (1953) as well as (1997), Gladiator (1992) as well as (2000), and
// Dune (1984) as well as (2021). Matching on title alone would show the
// wrong film about a third of the time here.
//
// Three rough groups, kept mixed rather than labelled, since the point is an
// opinion rather than a verdict:
//   - canonical, where the argument is whether it has aged
//   - divisive on release, where the argument never settled
//   - famously bad, where the argument is how bad
//
// Entries that do not match anything are skipped silently, so this list can
// be edited freely without checking the catalogue first.

const START_HERE = [
  // Canonical — the argument is whether they hold up.
  { title: 'The Godfather',                  year: 1972 },
  { title: 'Jaws',                           year: 1975 },
  { title: 'Alien',                          year: 1979 },
  { title: 'The Shining',                    year: 1980 },
  { title: 'Ghostbusters',                   year: 1984 },
  { title: 'Home Alone',                     year: 1990 },
  { title: 'Jurassic Park',                  year: 1993 },
  { title: 'Pulp Fiction',                   year: 1994 },
  { title: 'Forrest Gump',                   year: 1994 },
  { title: 'The Matrix',                     year: 1999 },
  { title: 'Fight Club',                     year: 1999 },
  { title: 'Gladiator',                      year: 2000 },
  { title: 'The Dark Knight',                year: 2008 },
  { title: 'Inception',                      year: 2010 },
  { title: 'Interstellar',                   year: 2014 },

  // Divisive — these are the ones that actually start arguments.
  { title: 'Grease',                         year: 1978 },
  { title: 'American Beauty',                year: 1999 },
  { title: 'Cast Away',                      year: 2000 },
  { title: 'Donnie Darko',                   year: 2001 },
  { title: 'Love Actually',                  year: 2003 },
  { title: 'Napoleon Dynamite',              year: 2004 },
  { title: 'The Notebook',                   year: 2004 },
  { title: 'Eternal Sunshine of the Spotless Mind', year: 2004 },
  { title: 'Titanic',                        year: 1997 },
  { title: 'Avatar',                         year: 2009 },
  { title: 'Prometheus',                     year: 2012 },
  { title: 'Man of Steel',                   year: 2013 },
  { title: 'Frozen',                         year: 2013 },
  { title: 'La La Land',                     year: 2016 },
  { title: 'Blade Runner 2049',              year: 2017 },
  { title: 'Bohemian Rhapsody',              year: 2018 },
  { title: 'Green Book',                     year: 2018 },
  { title: 'Joker',                          year: 2019 },
  { title: 'Dune',                           year: 2021 },
  { title: 'Top Gun: Maverick',              year: 2022 },
  { title: 'Barbie',                         year: 2023 },
  { title: 'Oppenheimer',                    year: 2023 },

  // Famously bad — the easiest opinion in the world to hold, and a rating is
  // one tap away.
  { title: 'Batman & Robin',                 year: 1997 },
  { title: 'The Room',                       year: 2003 },
  { title: 'Spider-Man 3',                   year: 2007 },
  { title: 'The Last Airbender',             year: 2010 },
  { title: 'Suicide Squad',                  year: 2016 },
  { title: 'Cats',                           year: 2019 },
  { title: 'Morbius',                        year: 2022 },
];

module.exports = { START_HERE };
