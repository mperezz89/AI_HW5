const SPORTS = [
  'Baseball',
  'Basketball',
  'Football',
  'Hockey',
  'Lacrosse',
  'Soccer',
  'Softball',
  'Swimming',
  'Tennis',
  'Track & Field',
  'Volleyball',
  'Wrestling',
  'Other',
];

const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

// The profile attributes every athlete is asked to fill in, in display order.
const PREFERRED_ATHLETE_FIELDS = [
  { key: 'athlete_code', label: 'Athlete ID' },
  { key: 'sport', label: 'Sport' },
  { key: 'high_school', label: 'School' },
  { key: 'position', label: 'Position' },
  { key: 'position_rank', label: 'Position ranking' },
  { key: 'star_rating', label: 'Star ranking' },
  { key: 'national_rank', label: 'National ranking' },
  { key: 'location', label: 'Location' },
  { key: 'bio', label: 'Profile bio' },
];

function missingPreferredFields(profile) {
  return PREFERRED_ATHLETE_FIELDS.filter(({ key }) =>
    key === 'location' ? !(profile.city || profile.state) : profile[key] === null || profile[key] === undefined || profile[key] === ''
  );
}

function stars(n) {
  return n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '';
}

module.exports = { SPORTS, US_STATES, VIDEO_MIME_TYPES, PREFERRED_ATHLETE_FIELDS, missingPreferredFields, stars };
