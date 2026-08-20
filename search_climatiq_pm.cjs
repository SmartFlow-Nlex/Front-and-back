const CLIMATIQ_API_KEY = '787RB3798N2C98A7F22A9K6C5R';

async function main() {
  // Search for emission factors that include particulate matter
  const searches = [
    'particulate matter vehicle diesel',
    'PM2.5 vehicle diesel',
    'sulfur dioxide vehicle diesel',
  ];

  for (const q of searches) {
    try {
      console.log(`\n=== Searching: "${q}" ===`);
      const response = await fetch(`https://api.climatiq.io/search?query=${encodeURIComponent(q)}&data_version=11`, {
        headers: { 'Authorization': `Bearer ${CLIMATIQ_API_KEY}` },
      });
      const data = await response.json();
      if (data.results && data.results.length > 0) {
        console.log(`Found ${data.results.length} results.`);
        data.results.slice(0, 5).forEach(r => {
          console.log(`  - ${r.activity_id}`);
          console.log(`    Name: ${r.name}`);
          console.log(`    Category: ${r.category}`);
          console.log(`    Source: ${r.source}`);
          console.log(`    Unit: ${r.unit_type}`);
          console.log(`    Constituent gases:`, JSON.stringify(r.constituent_gases || {}));
          console.log('');
        });
      } else {
        console.log('No results.');
        if (data.error) console.log(JSON.stringify(data));
      }
    } catch (err) {
      console.log(`Error: ${err.message}`);
    }
  }

  // Now try to get the estimate for each vehicle type and check if constituent_gases has pm25/so2
  const vehicles = [
    { id: 'passenger_vehicle-vehicle_type_car-fuel_source_petrol', label: 'Class 1 - Light (petrol car)', dv: '^11' },
    { id: 'commercial_vehicle-vehicle_type_hgv-fuel_source_diesel-engine_size_na-vehicle_age_post_2015-vehicle_weight_na', label: 'Class 2 - Medium (average HGV)', dv: '^11' },
    { id: 'commercial_vehicle-vehicle_type_hgv-fuel_source_diesel-engine_size_na-vehicle_age_post_2015-vehicle_weight_gt_30t', label: 'Class 3 - Heavy (>30t HGV)', dv: '^11' },
  ];

  for (const v of vehicles) {
    try {
      console.log(`\n=== Estimate for: ${v.label} ===`);
      const response = await fetch('https://api.climatiq.io/estimate', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CLIMATIQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          emission_factor: { activity_id: v.id, data_version: v.dv },
          parameters: { distance: 1, distance_unit: 'km' },
        }),
      });
      const data = await response.json();
      console.log(`Status: ${response.status}`);
      console.log(`CO2e: ${data.co2e} ${data.co2e_unit}`);
      console.log(`Constituent gases:`, JSON.stringify(data.constituent_gases, null, 2));
      console.log(`Additional indicators:`, JSON.stringify(data.additional_indicators, null, 2));
      console.log(`Source: ${data.emission_factor?.source} - ${data.emission_factor?.name}`);
    } catch (err) {
      console.log(`Error: ${err.message}`);
    }
  }
}

main();
