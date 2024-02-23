// Imports
const {Storage} = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const sharp = require('sharp');
const getExif = require('exif-async');
const parseDMS = require('parse-dms');
const {Firestore} = require('@google-cloud/firestore');


// Entry point function
exports.generateThumbnail = async (file, context) => {
  const gcsFile = file;
  const storage = new Storage();
  const sourceBucket = storage.bucket(gcsFile.bucket);
  const thumbnailsBucket = storage.bucket('jags-thumbnails');
  const finalBucket = storage.bucket('jags-final');

  // HINT HINT HINT
  const version = process.env.K_REVISION;
  console.log(`Running Cloud Function version ${version}`);

  console.log(`File name: ${gcsFile.name}`);
  console.log(`Generation number: ${gcsFile.generation}`);
  console.log(`Content type: ${gcsFile.contentType}`);

  // Reject images that are not jpeg or png files
  let fileExtension = '';
  let validFile = false;

  if (gcsFile.contentType === 'image/jpeg') {
    console.log('This is a JPG file.');
    fileExtension = 'jpg';
    validFile = true;

  } else if (gcsFile.contentType === 'image/png') {
    console.log('This is a PNG file.');
    fileExtension = 'png';
    validFile = true;

  } else {
    console.log('This is not a valid file.');
  }

  // If the file is a valid photograph, download it to the 'local' VM so that we can create a thumbnail image
  if (validFile) {
    // Create a new filename for the 'final' version of the image file
    // The value of this will be something like '12745649237578595.jpg'
    const finalFileName = `${gcsFile.generation}.${fileExtension}`;

    // Create a working directory on the VM that runs our GCF to download the original file
    // The value of this variable will be something like 'tmp/thumbs'
    const workingDir = path.join(os.tmpdir(), 'thumbs');

    // Create a variable that holds the path to the 'local' version of the file
    // The value of this will be something like 'tmp/thumbs/398575858493.png'
    const tempFilePath = path.join(workingDir, finalFileName);

    // Wait until the working directory is ready
    await fs.ensureDir(workingDir);

    // Download the original file to the path on the 'local' VM
    await sourceBucket.file(gcsFile.name).download({
      destination: tempFilePath
    });

    // Pass the local file to the helper function and extract the exif data
    const gpsObject = await readExifData(tempFilePath);
    console.log(gpsObject);

    // Get the correct format for the latitude and longitude values
    const gpsDecimal = getGPSCords(gpsObject);
    console.log(gpsDecimal);

    // Upload our local version of the file to the final images bucket
    await finalBucket.upload(tempFilePath);

    // Construct the HTTP URL of the uploaded image directly
    const finalImageUrl = `https://storage.cloud.google.com/${finalBucket.name}/${finalFileName}?authuser=1`;

    console.log(`Final Image URL: ${finalImageUrl}`);

    // Create a name for the thumbnail image
    // The value for this will be something like `thumb@64_1234567891234567.jpg`
    const thumbName = `thumb@64_${finalFileName}`;

    // Create a path where we will store the thumbnail image locally
    // This will be something like `tmp/thumbs/thumb@64_1234567891234567.jpg`
    const thumbPath = path.join(workingDir, thumbName);

    // Use the sharp library to generate the thumbnail image and save it to the thumbPath
    // Then upload the thumbnail to the thumbnailsBucket in cloud storage
    await sharp(tempFilePath).resize(64).withMetadata().toFile(thumbPath);
      await thumbnailsBucket.upload(thumbPath);

    // Construct the HTTP URL of the uploaded thumbnail image directly
    const thumbUrl = `https://storage.cloud.google.com/${thumbnailsBucket.name}/${thumbName}?authuser=1`;

    console.log(`Thumbnail Image HTTP URL: ${thumbUrl}`);

    // Delete the temp working directory and its files from the GCF's VM
    await fs.remove(workingDir);

    // Establish a reference to firestore
    const firestore = new Firestore({
      projectId: "globaljags-project-41200"
    });

    // Create a data object to store image info
    let dataObject = {};

    // Add the image info to the object
    dataObject.imageName = finalFileName;
    dataObject.imageURL = finalImageUrl;
    dataObject.lat = gpsDecimal.lat;
    dataObject.long = gpsDecimal.lon;
    dataObject.thumbURL = thumbUrl;

    // Create a new collection within the database and add the object
    let collectionRef = firestore.collection('photos');
    let documentRef = await collectionRef.add(dataObject);
    console.log(`Document Created: ${documentRef.id}`);
    

  } // end of validFile==true

  // DELETE the original file uploaded to the "Uploads" bucket
  await sourceBucket.file(gcsFile.name).delete();
  console.log(`Deleted uploaded file: ${gcsFile.name}`);
}

// Helper functions
async function readExifData (localFile) {
  //Create a varibale to store the exif data
  let exifData;

  // If the exif data exists, return the gps info, otherwise return an error
  try {
      exifData = await getExif(localFile);
      return(exifData.gps);
  } catch (err) {
      console.log(err);
      return null;
  }
}


function getGPSCords(g) {
  // Parse DMS needs a string in the format of:
  // 51:30:0.5486N 0:7:34.4503W
  // DEG:MIN:SECDIRECTION DEG:MIN:SECDIRECTION
  const latString = `${g.GPSLatitude[0]}:${g.GPSLatitude[1]}:${g.GPSLatitude[2]}${g.GPSLatitudeRef}`;
  const longString = `${g.GPSLongitude[0]}:${g.GPSLongitude[1]}:${g.GPSLongitude[2]}${g.GPSLongitudeRef}`;

  // Use the parse-dms package to convert from DMS to decimal values
  const degCords = parseDMS(`${latString} ${longString}`);

  // Return an object with the latitude and longitude in decimal
  return degCords;
}
