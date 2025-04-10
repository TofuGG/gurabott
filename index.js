// index.js
console.log('Friday, August 16, 2024');

// Build the project
console.log ('Building the project...');
require('child_process').execSync('npm install');

// Start the project
console.log('Starting the project...');
require('child_process').execSync('pnpm run start');

