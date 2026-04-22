import urllib.request
import os

url = "https://github.com/DariusAf/MesoNet/raw/master/weights/MesoInception4.h5"
dest = "MesoInception4.h5"

print(f"Downloading from: {url}")
print("This may take a minute...")

urllib.request.urlretrieve(url, dest)

size = os.path.getsize(dest)
print(f"Done! File size: {size:,} bytes ({size/1024/1024:.1f} MB)")

if size < 1_000_000:
    print("WARNING: File is too small! Expected ~27MB. Download may have failed.")
else:
    print("File size looks correct!")
