import fs from 'fs';
import axios from 'axios';
import { ApkParser, IpaParser } from 'build-info-parser';
import FormData from 'form-data';
import ApiConst from './ApiConst';
import AppConst from './AppConst';
import { getApkName } from './CommonUtils';
import jwt from 'jsonwebtoken';
import {
  AppPlatform,
  DecodedToken,
  FileContentType,
  FileType
} from './types/CommonTypes';

/**
 * Extract the build data from the file
 * @param file - The build file
 * @param fileType - The type of the build file
 * @param blobData - The blob data of the build file
 * @returns - The extracted build data
 */
const fileDataExtract = async (file: any, fileType: string, blobData: Blob) => {
  if (fileType === FileType.Ipa && file) {
    // @ts-ignore
    const parser = new IpaParser(file);
    try {
      const applicationData = await parser.parse();
      return {
        ...applicationData,
        name: String(
          applicationData?.CFBundleDisplayName ?? AppConst.appDefaultName
        ),
        package: String(
          applicationData?.CFBundleIdentifier ?? AppConst.appDefaultPackage
        ),
        versionCode: Number(
          applicationData?.CFBundleVersion ?? AppConst.appDefaultVersionCode
        ),
        versionName: String(
          applicationData?.CFBundleShortVersionString ??
            AppConst.appDefaultVersion
        ),
        fileType: FileType.Ipa,
        fileContentType: FileContentType.Ipa,
        appIcon: applicationData?.icon ?? '',
        fileSize: blobData.size
      };
    } catch (error) {
      console.error(error);
    }
  } else if (fileType === FileType.Apk && file) {
    const parser = new ApkParser(file);
    try {
      const applicationData = await parser.parse();
      if (blobData.size) {
        return {
          ...applicationData,
          name:
            getApkName(applicationData?.application?.label) ??
            AppConst.appDefaultName,
          fileType: FileType.Apk,
          fileContentType: FileContentType.Apk,
          appIcon: applicationData?.icon ?? '',
          fileSize: blobData.size
        };
      }
    } catch (error) {
      console.error(`Error parsing APK File: ${error}`);
    }
  } else {
    console.error('Invalid file type');
  }
};

/**
 * Main function to handle the post-build process
 */
const deployApp = async (
  applicationId: string,
  buildPath: string,
  appToken: any,
  baseUrl?: string,
  releaseNotes?: string
) => {
  // Use applicationId and buildPath in your deployment logic
  console.log(`Deploying Application ID: ${applicationId}`);
  console.log(`Using Build Path: ${buildPath}`);

  if (!applicationId) {
    console.error('Application ID is missing');
    process.exit(1);
  }
  if (!buildPath || !fs.existsSync(buildPath)) {
    console.error('Build file not found:', buildPath);
    process.exit(1);
  }
  if (!appToken) {
    console.error('App token is missing');
    process.exit(1);
  }

  const decodedToken = jwt.decode(appToken) as DecodedToken;

  const decodedApplicationId = decodedToken ? decodedToken.app : '';

  if (applicationId !== decodedApplicationId) {
    console.error('Application ID does not match the application token.');
    process.exit(1);
  }

  const decodedBaseUrl = decodedToken?.baseUrl;
  const currentUrl = baseUrl || decodedBaseUrl;

  if (!currentUrl) {
    console.error('Base URL is missing');
    process.exit(1);
  }
  const fileType = buildPath?.split('.')?.pop() ?? FileType.Apk;

  const currentFileContentType =
    fileType === FileType.Ipa ? FileContentType.Ipa : FileContentType.Apk;

  const fileBuffer = fs.readFileSync(buildPath);

  const chunkSize = AppConst.chunkSize * 1024 * 1024; // 100MB

  const fileSize = fs.statSync(buildPath).size;

  const totalChunks = Math.ceil(fileSize / chunkSize);

  const fileStream = fs.createReadStream(buildPath, {
    highWaterMark: chunkSize
  });

  let chunkNumber = 1;
  let downloadPath = '';

  const blobData = new Blob([fileBuffer], {
    type: currentFileContentType
  });

  try {
    console.log('Processing build...');
    const buildInfo = await fileDataExtract(buildPath, fileType, blobData);

    // Check if the build already exists
    const buildExistResponse = await axios.post(
      `${currentUrl}/${ApiConst.buildsExist}`,
      {
        application_id: applicationId,
        version_code: buildInfo.versionCode?.toString(),
        version_name: buildInfo.versionName?.toString(),
        platform:
          buildInfo.fileType === FileType.Ipa
            ? AppPlatform.IOS
            : AppPlatform.Android
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${appToken}`
        }
      }
    );

    if (buildExistResponse.status === 409) {
      return buildExistResponse;
    }

    for await (const chunk of fileStream) {
      const formData = new FormData();

      formData.append('applicationId', applicationId);
      formData.append('buildInfo', JSON.stringify(buildInfo));
      formData.append('currentFileContentType', currentFileContentType);
      formData.append('baseUrl', currentUrl);
      formData.append('appToken', appToken);

      if (releaseNotes) {
        formData.append('releaseNotes', `<pre>${releaseNotes}</pre>`);
      }

      fileStream.on('error', err => {
        console.error('Error reading the file:', err);
      });
      // Add current chunk
      formData.append('file', chunk, {
        contentType: currentFileContentType,
        filename: `chunk-${chunkNumber}`
      });

      // Add chunk metadata
      formData.append('chunkNumber', chunkNumber);
      formData.append('totalChunks', totalChunks);

      const response = await axios.post(
        `${currentUrl}/${ApiConst.deployAppToPocketDeploy}`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            Authorization: `Bearer ${appToken}`
          }
        }
      );

      if (response.status === 200) {
        const percentage = Math.floor((chunkNumber / totalChunks) * 100);
        console.log(`Upload Progress: ${percentage}%`);

        if (response?.data?.downloadPath) {
          downloadPath = response?.data?.downloadPath;
        }

        // Increment the chunk number
        chunkNumber++;
      } else {
        throw new Error(`Failed to upload build`);
      }
    }

    console.log('Build Uploaded successfully');
    !!downloadPath && console.log('Download Path:', downloadPath);
    return;
  } catch (error) {
    console.error(
      'Error during uploading the build:',
      error.response?.data ?? error
    );
  }
};

export default deployApp;
