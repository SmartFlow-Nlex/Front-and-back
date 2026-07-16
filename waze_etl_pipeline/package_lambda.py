# package_lambda.py
import os
import shutil
import zipfile
import subprocess
import sys

def build():
    print("Building Lambda deployment package...")
    dist_dir = "lambda_dist"
    if os.path.exists(dist_dir):
        shutil.rmtree(dist_dir)
    os.makedirs(dist_dir)

    # Copy script files
    print("Copying code files...")
    shutil.copy("waze_etl.py", os.path.join(dist_dir, "waze_etl.py"))
    shutil.copy("lambda_function.py", os.path.join(dist_dir, "lambda_function.py"))

    # Create temporary directory for downloads
    wheels_dir = "temp_wheels"
    if os.path.exists(wheels_dir):
        shutil.rmtree(wheels_dir)
    os.makedirs(wheels_dir)

    try:
        # Download manylinux wheels for Python 3.11
        # Python 3.11 is supported in AWS Lambda.
        # We need psycopg2-binary and requests (including its dependencies: urllib3, idna, charset-normalizer, certifi)
        packages = ["psycopg2-binary", "requests"]
        print(f"Downloading Linux wheels for: {packages}...")
        
        # Run pip download
        cmd = [
            sys.executable, "-m", "pip", "download",
            "--only-binary=:all:",
            "--platform", "manylinux2014_x86_64",
            "--python-version", "3.11",
            "--implementation", "cp",
            "--abi", "cp311",
            "--dest", wheels_dir
        ] + packages
        
        subprocess.check_call(cmd)
        
        # Unzip each wheel into the dist directory
        for file in os.listdir(wheels_dir):
            if file.endswith(".whl"):
                wheel_path = os.path.join(wheels_dir, file)
                print(f"Extracting {file}...")
                with zipfile.ZipFile(wheel_path, 'r') as zip_ref:
                    zip_ref.extractall(dist_dir)
                    
        # Remove metadata folders to keep zip clean
        for item in os.listdir(dist_dir):
            item_path = os.path.join(dist_dir, item)
            if os.path.isdir(item_path) and (item.endswith(".dist-info") or item.endswith(".egg-info") or item == "__pycache__"):
                shutil.rmtree(item_path)
                
        # Zip everything in dist_dir into waze_etl_deployment.zip
        zip_filename = "waze_etl_deployment.zip"
        if os.path.exists(zip_filename):
            os.remove(zip_filename)
            
        print(f"Creating {zip_filename}...")
        with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk(dist_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, dist_dir)
                    zipf.write(file_path, arcname)
                    
        print(f"Successfully created {zip_filename}!")
    finally:
        # Cleanup
        print("Cleaning up temporary directories...")
        if os.path.exists(wheels_dir):
            shutil.rmtree(wheels_dir)
        if os.path.exists(dist_dir):
            shutil.rmtree(dist_dir)

if __name__ == "__main__":
    build()
