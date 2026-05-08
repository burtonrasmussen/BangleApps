// Zambretti barometer weather forecast algorithm
// Input:  pressure trend over ~3 hours, current pressure (hPa), hemisphere ('N'|'S')
// Output: { letter: "A", forecast: "Settled Fine" }
//
// Reference: https://www.boock.ch/meteo/zambretti.pdf

exports.forecast = function(trend, pressureHpa, hemisphere) {
  // Normalise to sea level if needed — caller should pass SLP already.
  // Zambretti uses millibars (=hPa). Range roughly 950–1050.
  var p = pressureHpa;

  // Southern hemisphere: invert wind sense, so we flip rising/falling
  if (hemisphere === 'S') {
    if (trend === 'rising')  trend = 'falling';
    else if (trend === 'falling') trend = 'rising';
  }

  var letter;
  if (trend === 'rising') {
    if (p >= 1030)              letter = 'A';
    else if (p >= 1020)         letter = 'B';
    else if (p >= 1010)         letter = 'C';
    else if (p >= 1000)         letter = 'D';
    else if (p >= 990)          letter = 'E';
    else if (p >= 980)          letter = 'F';
    else if (p >= 970)          letter = 'G';
    else                        letter = 'H';
  } else if (trend === 'falling') {
    if (p >= 1030)              letter = 'B';
    else if (p >= 1020)         letter = 'D';
    else if (p >= 1010)         letter = 'H';
    else if (p >= 1000)         letter = 'O';
    else if (p >= 990)          letter = 'R';
    else if (p >= 980)          letter = 'U';
    else if (p >= 970)          letter = 'V';
    else                        letter = 'X';
  } else { // steady
    if (p >= 1030)              letter = 'A';
    else if (p >= 1020)         letter = 'B';
    else if (p >= 1010)         letter = 'C';
    else if (p >= 1000)         letter = 'J';
    else if (p >= 990)          letter = 'K';
    else if (p >= 980)          letter = 'L';
    else if (p >= 970)          letter = 'M';
    else                        letter = 'N';
  }

  var FORECASTS = {
    A: "Settled Fine",
    B: "Fine Weather",
    C: "Fine, Becoming Less Settled",
    D: "Fine, Possibly Showers",
    E: "Fairly Fine, Windy",
    F: "Fairly Fine, Improvement",
    G: "Fairly Fine, Possibly Showers",
    H: "Showery, Becoming More Unsettled",
    J: "Rather Unsettled, Clear Spells",
    K: "Unsettled, Rain at Times",
    L: "Unsettled, Rain at Intervals",
    M: "Very Unsettled, Rain",
    N: "Stormy, Very Heavy Rain",
    O: "Very Unsettled, Rain at Times",
    R: "Unsettled, Heavy Rain",
    U: "Stormy, Probably Rain",
    V: "Stormy, Heavy Rain",
    X: "Stormy, Very Heavy Rain"
  };

  return { letter: letter, forecast: FORECASTS[letter] || "Unknown" };
};

// Determine trend from a circular pressure buffer (array of {t,p} or just numbers)
// Returns 'rising' | 'falling' | 'steady'
exports.trend = function(readings) {
  if (!readings || readings.length < 2) return 'steady';
  var oldest = typeof readings[0] === 'object' ? readings[0].p : readings[0];
  var newest = typeof readings[readings.length - 1] === 'object'
    ? readings[readings.length - 1].p
    : readings[readings.length - 1];
  var delta = newest - oldest;
  if (delta >  1.6) return 'rising';
  if (delta < -1.6) return 'falling';
  return 'steady';
};
