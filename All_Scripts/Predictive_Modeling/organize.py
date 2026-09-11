import os
import shutil

base_dir = r'C:/Users/Hans/.gemini/antigravity/scratch/training_and_testing_outputs'

# Create directories
dirs = {
    'dataset': os.path.join(base_dir, '01_dataset'),
    'final_eval': os.path.join(base_dir, '02_final_evaluation_walkforward'),
    'final_models': os.path.join(base_dir, '02_final_evaluation_walkforward', 'model_results'),
    'deprecated': os.path.join(base_dir, '03_deprecated_single_split')
}

for d in dirs.values():
    os.makedirs(d, exist_ok=True)

for file in os.listdir(base_dir):
    src = os.path.join(base_dir, file)
    if not os.path.isfile(src): continue
    
    if file == 'traffic_speed_dataset.csv':
        shutil.move(src, os.path.join(dirs['dataset'], file))
    
    elif file in ['MODEL_EVALUATION_REPORT.txt', 'wf_all_models_metrics.csv', 'model_selection_results.json'] or file.startswith('chart_wf_'):
        shutil.move(src, os.path.join(dirs['final_eval'], file))
        
    elif file.startswith('wf_') and file.endswith('.json'):
        shutil.move(src, os.path.join(dirs['final_models'], file))
        
    else:
        # Everything else is old/deprecated or feature importances from old runs
        shutil.move(src, os.path.join(dirs['deprecated'], file))
