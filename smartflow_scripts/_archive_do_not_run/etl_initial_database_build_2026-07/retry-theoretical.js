throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
import { exec } from 'child_process';

function runComputation() {
  console.log('🔄 Attempting to connect to AWS RDS...');
  
  const child = exec('node compute-theoretical-emissions.js');
  
  child.stdout.on('data', data => process.stdout.write(data));
  child.stderr.on('data', data => process.stderr.write(data));
  
  child.on('exit', code => {
    if (code !== 0) {
      console.log('⚠️ AWS RDS still offline. Retrying in 10 seconds...');
      setTimeout(runComputation, 10000);
    } else {
      console.log('🎉 Computation completely finished successfully!');
    }
  });
}

runComputation();
