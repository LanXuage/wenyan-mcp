import { JSDOM } from "jsdom";
import { FormData, File } from 'formdata-node';
import { fileFromPath } from 'formdata-node/file-from-path';
import path from "path";
import fs from "fs";
import util from "util";

const tokenUrl = "https://api.weixin.qq.com/cgi-bin/token";
const publishUrl = "https://api.weixin.qq.com/cgi-bin/draft/add";
const uploadUrl = `https://api.weixin.qq.com/cgi-bin/material/add_material`;
const hostImagePath = process.env.HOST_IMAGE_PATH || "";
const dockerImagePath = "/mnt/host-downloads";

type UploadResponse = {
    media_id: string;
    url: string
};

// 日志工具
function log(...args: any[]) {
    const msg = `[${new Date().toISOString()}] ${args.map(a => (typeof a === "string" ? a : util.inspect(a, { depth: 5 }))).join(" ")}`;
    console.log(msg);
    try {
        fs.appendFileSync("wenyan-mcp.log", msg + "\n");
    } catch (e: unknown) {
        console.log(`Failed to write to log file${e}`);
    }
}

async function fetchAccessToken(appid?: string, appsecret?: string) {
    log("Fetching access token", { appid, appsecret });
    const appIdToUse = appid || process.env.WECHAT_APP_ID || "";
    const appSecretToUse = appsecret || process.env.WECHAT_APP_SECRET || "";
    const response = await fetch(`${tokenUrl}?grant_type=client_credential&appid=${appIdToUse}&secret=${appSecretToUse}`);
    const data = await response.json();
    if (data.access_token) {
        log("Access token fetched");
        return data;
    } else if (data.errcode) {
        log("Access token fetch error", data);
        throw new Error(`获取 Access Token 失败，错误码：${data.errcode}，${data.errmsg}`);
    } else {
        log("Access token fetch unknown error", data);
        throw new Error(`获取 Access Token 失败: ${data}`);
    }
}

async function uploadMaterial(type: string, fileData: Blob | File, fileName: string, accessToken: string): Promise<UploadResponse> {
    log("Uploading material", { type, fileName });
    const form = new FormData();
    form.append("media", fileData, fileName);
    const response = await fetch(`${uploadUrl}?access_token=${accessToken}&type=${type}`, {
        method: 'POST',
        body: form as any,
    });
    if (!response.ok) {
        const errorText = await response.text();
        log("Upload failed", { status: response.status, errorText });
        throw new Error(`上传失败: ${response.status} ${errorText}`);
    }
    const data = await response.json();
    if (data.errcode) {
        log("Upload error", data);
        throw new Error(`上传失败，错误码：${data.errcode}，错误信息：${data.errmsg}，链接：`);
    }
    const result = data.url.replace("http://", "https://");
    data.url = result;
    log("Upload success", { media_id: data.media_id, url: data.url });
    return data;
}

async function uploadImage(imageUrl: string, accessToken: string, fileName?: string): Promise<UploadResponse> {
    log("Uploading image", { imageUrl, fileName });
    if (imageUrl.startsWith("http")) {
        const response = await fetch(imageUrl);
        if (!response.ok || !response.body) {
            log("Failed to download image from URL", imageUrl);
            throw new Error(`Failed to download image from URL: ${imageUrl}`);
        }
        const fileNameFromUrl = path.basename(imageUrl.split("?")[0]);
        const ext = path.extname(fileNameFromUrl);
        const imageName = fileName ?? (ext === "" ? `${fileNameFromUrl}.jpg` : fileNameFromUrl);
        const buffer = await response.arrayBuffer();
        return await uploadMaterial('image', new Blob([buffer]), imageName, accessToken);
    } else {
        const localImagePath = hostImagePath ? imageUrl.replace(hostImagePath, dockerImagePath) : imageUrl;
        const fileNameFromLocal = path.basename(localImagePath);
        const ext = path.extname(fileNameFromLocal);
        const imageName = fileName ?? (ext === "" ? `${fileNameFromLocal}.jpg` : fileNameFromLocal);
        const file = await fileFromPath(localImagePath);
        return await uploadMaterial('image', file, imageName, accessToken);
    }
}

async function uploadImages(content: string, accessToken: string): Promise<{ html: string, firstImageId: string }> {
    log("Uploading images in content");
    if (!content.includes('<img')) {
        log("No images found in content");
        return { html: content, firstImageId: "" };
    }

    const dom = new JSDOM(content);
    const document = dom.window.document;
    const images = Array.from(document.querySelectorAll('img'));

    const uploadPromises = images.map(async (element) => {
        const dataSrc = element.getAttribute('src');
        if (dataSrc) {
            if (!dataSrc.startsWith('https://mmbiz.qpic.cn')) {
                const resp = await uploadImage(dataSrc, accessToken);
                element.setAttribute('src', resp.url);
                return resp.media_id;
            } else {
                return dataSrc;
            }
        }
        return null;
    });

    const mediaIds = (await Promise.all(uploadPromises)).filter(Boolean);
    const firstImageId = mediaIds[0] || "";

    const updatedHtml = dom.serialize();
    log("Images uploaded", { count: images.length, firstImageId });
    return { html: updatedHtml, firstImageId };
}

export async function publishToDraft(
    title: string,
    content: string,
    cover: string,
    appid?: string,
    appsecret?: string
) {
    log("Publishing to draft", { title, cover, appid });
    const accessToken = await fetchAccessToken(appid, appsecret);
    const { html, firstImageId } = await uploadImages(content, accessToken.access_token);
    let thumbMediaId = "";
    if (cover) {
        const resp = await uploadImage(cover, accessToken.access_token, "cover.jpg");
        thumbMediaId = resp.media_id;
    } else {
        if (firstImageId.startsWith("https://mmbiz.qpic.cn")) {
            const resp = await uploadImage(firstImageId, accessToken.access_token, "cover.jpg");
            thumbMediaId = resp.media_id;
        } else {
            thumbMediaId = firstImageId;
        }
    }
    if (!thumbMediaId) {
        log("No cover image found");
        throw new Error("你必须指定一张封面图或者在正文中至少出现一张图片。");
    }
    const response = await fetch(`${publishUrl}?access_token=${accessToken.access_token}`, {
        method: 'POST',
        body: JSON.stringify({
            articles: [{
                title: title,
                content: html,
                thumb_media_id: thumbMediaId,
            }]
        })
    });
    const data = await response.json();
    if (data.media_id) {
        log("Draft published", { media_id: data.media_id });
        return data;
    } else if (data.errcode) {
        log("Draft publish error", data);
        throw new Error(`上传到公众号草稿失败，错误码：${data.errcode}，${data.errmsg}`);
    } else {
        log("Draft publish unknown error", data);
        throw new Error(`上传到公众号草稿失败: ${data}`);
    }
}
