const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:Hanszy123!@smartflow-db.choym2mcymec.ap-southeast-1.rds.amazonaws.com:5432/nlex_capstone',
  ssl: { rejectUnauthorized: false }
});

const exitsData = [
  { exit_id: 1,  exit_name: 'Balintawak',              latitude: 14.67876672198161,  longitude: 121.00008900172813, sb_entry: false, sb_exit: true,  nb_entry: true,  nb_exit: false },
  { exit_id: 2,  exit_name: 'NLEX Harbor Link',        latitude: 14.693465298536088, longitude: 121.0003079375893,  sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 3,  exit_name: 'Paso De Blas Valenzuela', latitude: 14.708213486172651, longitude: 120.99300157701673, sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 4,  exit_name: 'Meycauayan',              latitude: 14.74638836470472,  longitude: 120.9723156192843,  sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 5,  exit_name: 'Marilao',                 latitude: 14.77456202043474,  longitude: 120.9572673295301,  sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 6,  exit_name: 'Cdv/Ph Arena',            latitude: 14.793123785151655, longitude: 120.94725606760602, sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 7,  exit_name: 'Bocaue Barrier',          latitude: 14.802456193901511, longitude: 120.94245608845259, sb_entry: false, sb_exit: true,  nb_entry: false, nb_exit: false },
  { exit_id: 8,  exit_name: 'Bocaue Interchange',      latitude: 14.807233925154666, longitude: 120.93939984817274, sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 9,  exit_name: 'Tambubong',               latitude: 14.815123897282831, longitude: 120.93507141724179, sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 10, exit_name: 'Tabang Guiguinto',        latitude: 14.83274649661766,  longitude: 120.9039112162981,  sb_entry: true,  sb_exit: false, nb_entry: false, nb_exit: true  },
  { exit_id: 11, exit_name: 'Balagtas',                latitude: 14.83443660148125,  longitude: 120.90063378190028, sb_entry: true,  sb_exit: false, nb_entry: true,  nb_exit: true  },
  { exit_id: 12, exit_name: 'Sta. Rita Guiguinto',     latitude: 14.862453405921645, longitude: 120.85888660798751, sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 13, exit_name: 'Pulilan',                 latitude: 14.908258043486079, longitude: 120.81701519028174, sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 14, exit_name: 'San Simon',               latitude: 14.990134507492616, longitude: 120.74996867688135, sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 15, exit_name: 'San Fernando',            latitude: 15.049706053892223, longitude: 120.69485632354187, sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 16, exit_name: 'Mexico',                  latitude: 15.105216776242122, longitude: 120.66361945309848, sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 17, exit_name: 'Angeles',                 latitude: 15.163114265039983, longitude: 120.61345871762175, sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 18, exit_name: 'Dau',                     latitude: 15.178009469031895, longitude: 120.60462937006393, sb_entry: true,  sb_exit: true,  nb_entry: true,  nb_exit: true  },
  { exit_id: 19, exit_name: 'Sctex',                   latitude: 15.196300930675244, longitude: 120.59712067640591, sb_entry: true,  sb_exit: false, nb_entry: false, nb_exit: true  },
  { exit_id: 20, exit_name: 'Sta. Ines',               latitude: 15.222036544247922, longitude: 120.5878349324598,  sb_entry: true,  sb_exit: false, nb_entry: false, nb_exit: true  }
];

async function main() {
  console.log('=== Step 1: Adding direction columns to bronze.nlex_exits if not present ===');
  await pool.query(`
    ALTER TABLE bronze.nlex_exits
    ADD COLUMN IF NOT EXISTS sb_entry boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS sb_exit boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS nb_entry boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS nb_exit boolean DEFAULT true
  `);
  console.log('Columns ensured.');

  console.log('=== Step 2: Updating rows in bronze.nlex_exits ===');
  for (const item of exitsData) {
    await pool.query(`
      INSERT INTO bronze.nlex_exits (exit_id, exit_name, latitude, longitude, sb_entry, sb_exit, nb_entry, nb_exit)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (exit_id) DO UPDATE SET
        exit_name = EXCLUDED.exit_name,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        sb_entry = EXCLUDED.sb_entry,
        sb_exit = EXCLUDED.sb_exit,
        nb_entry = EXCLUDED.nb_entry,
        nb_exit = EXCLUDED.nb_exit,
        recorded_at = NOW()
    `, [item.exit_id, item.exit_name, item.latitude, item.longitude, item.sb_entry, item.sb_exit, item.nb_entry, item.nb_exit]);
  }
  console.log('20 exit rows updated.');

  console.log('=== Step 3: Re-creating public.nlex_exits view ===');
  await pool.query('DROP VIEW IF EXISTS public.nlex_exits CASCADE');
  await pool.query(`
    CREATE OR REPLACE VIEW public.nlex_exits AS
    SELECT id, exit_id, exit_name, latitude, longitude, sb_entry, sb_exit, nb_entry, nb_exit, recorded_at
    FROM bronze.nlex_exits
    ORDER BY exit_id ASC
  `);
  console.log('public.nlex_exits view updated.');

  console.log('=== Step 4: Verification ===');
  const result = await pool.query('SELECT * FROM public.nlex_exits ORDER BY exit_id');
  console.table(result.rows);

  await pool.end();
}

main().catch(e => {
  console.error('Error updating exits:', e);
  pool.end();
});
