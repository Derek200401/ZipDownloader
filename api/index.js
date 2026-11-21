const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();
app.set('trust proxy', true);

const SECRET_KEY = process.env.HYDRA_SECRET_KEY || 'derek-dek-dek-200401';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const APP_ROOT = path.resolve(__dirname, '..');
const ASSETS_ROOT = path.join(APP_ROOT, 'heroes');
const ROLE_FILES = new Set([
    'AssassinSkin.json',
    'FighterSkin.json',
    'MageSkin.json',
    'MarksmanSkin.json',
    'SupportSkin.json',
    'TankSkin.json'
]);
const jsonCache = new Map();

function heroSlug(name) {
    return String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function normalizeName(name) {
    return String(name)
        .normalize('NFKC')
        .replace(/[^a-z0-9]+/gi, ' ')
        .trim()
        .toLowerCase();
}

function resolveAsset(directory, name, extension) {
    if (!name || !fs.existsSync(directory)) return null;
    const direct = path.join(directory, `${name}${extension}`);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
    const lowerName = `${name}${extension}`.toLowerCase();
    const normalized = normalizeName(name);
    for (const entry of fs.readdirSync(directory)) {
        if (path.extname(entry).toLowerCase() !== extension) continue;
        if (entry.toLowerCase() === lowerName) return path.join(directory, entry);
        if (normalizeName(path.parse(entry).name) === normalized) return path.join(directory, entry);
    }
    return null;
}

function safeAssetPath(relativePath) {
    if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
        throw new Error('Unsafe path');
    }
    const resolved = path.resolve(APP_ROOT, relativePath);
    if (resolved !== ASSETS_ROOT && !resolved.startsWith(ASSETS_ROOT + path.sep)) {
        throw new Error('Unsafe path');
    }
    return resolved;
}

function assetUrl(req, relativePath) {
    return `${req.protocol}://${req.get('host')}/api/download?type=image&file=${encodeURIComponent(relativePath)}`;
}

function audioOrder(a, b) {
    const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
    const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
    return na - nb;
}

function buildRoleJson(req, fileName) {
    const origin = `${req.protocol}://${req.get('host')}`;
    const cacheKey = `${origin}|${fileName}`;
    const cached = jsonCache.get(cacheKey);
    if (cached) return cached;

    const roles = JSON.parse(fs.readFileSync(path.join(APP_ROOT, fileName), 'utf8'));
    const proxyBase = `${origin}/api/download?type=zip&file=`;

    for (const heroName of Object.keys(roles)) {
        if (!Array.isArray(roles[heroName])) continue;
        const slug = heroSlug(heroName);
        const heroFolder = path.join(ASSETS_ROOT, slug);
        const audioFolder = path.join(heroFolder, 'audio');
        const audioFiles = fs.existsSync(audioFolder)
            ? fs.readdirSync(audioFolder).filter((entry) => entry.toLowerCase().endsWith('.ogg')).sort(audioOrder)
            : [];
        const audioLink = audioFiles
            .map((entry) => assetUrl(req, `heroes/${slug}/audio/${entry}`))
            .join(',');
        const iconPath = path.join(heroFolder, 'icon.webp');
        const icon = fs.existsSync(iconPath) ? assetUrl(req, `heroes/${slug}/icon.webp`) : '';

        for (const skin of roles[heroName]) {
            const skinName = skin.skins_name || skin.skin_name || skin.skinName || '';
            const infoPath = resolveAsset(path.join(heroFolder, 'info'), skinName, '.json');
            const info = infoPath ? JSON.parse(fs.readFileSync(infoPath, 'utf8')) : {};
            const price = Object.assign({}, info.price || {});
            price.battle_points = info.price && info.price.bp != null ? String(info.price.bp) : '';
            price.diamond = info.price && info.price.dm != null ? String(info.price.dm) : '';

            const portraitPath = resolveAsset(path.join(heroFolder, 'portrait'), skinName, '.webp');
            const splashPath = resolveAsset(path.join(heroFolder, 'splash'), skinName, '.webp');
            const tagPath = resolveAsset(path.join(heroFolder, 'tags'), skinName, '.webp');
            const skills = Array.isArray(info.skills)
                ? info.skills.map((skill) => {
                    const skillIconPath = resolveAsset(path.join(heroFolder, 'skill'), skill.skill_name || '', '.webp');
                    return Object.assign({}, skill, {
                        skill_icon: skillIconPath
                            ? assetUrl(req, `heroes/${slug}/skill/${path.basename(skillIconPath)}`)
                            : ''
                    });
                })
                : [];

            const zipUrl = `${proxyBase}${encodeURIComponent(`${heroName} ${skinName}.zip`)}`;

            Object.assign(skin, {
                skins_name: skinName,
                portrait: portraitPath ? assetUrl(req, `heroes/${slug}/portrait/${path.basename(portraitPath)}`) : '',
                splash: splashPath ? assetUrl(req, `heroes/${slug}/splash/${path.basename(splashPath)}`) : '',
                icon,
                tag_url: tagPath ? assetUrl(req, `heroes/${slug}/tags/${path.basename(tagPath)}`) : '',
                audio_link: audioLink,
                zip_url: zipUrl,
                zip_fallback_url: zipUrl,
                release: info.release || 'N/A',
                availability: info.availability || 'N/A',
                rarity: info.rarity || 'N/A',
                label: info.label || 'N/A',
                price,
                skills
            });
        }
    }

    jsonCache.set(cacheKey, roles);
    return roles;
}

app.get('/api/download', async (req, res) => {
    const userAgent = req.headers['user-agent'] || '';
    if (!userAgent.includes('HydraToolsApp')) {
        return res.status(401).json({ error: "401 Unauthorized. Access Denied." });
    }
    if (req.headers['x-hydra-auth'] !== SECRET_KEY) {
        return res.status(401).json({ error: "401 Unauthorized. Invalid Token." });
    }

    const { file, type, url } = req.query;

    // --- IMAGE PROXY ENDPOINT ---
    if (type === 'image') {
        if (file) {
            try {
                const assetPath = safeAssetPath(file);
                const extension = path.extname(assetPath).toLowerCase();
                if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile() ||
                    (extension !== '.webp' && extension !== '.ogg')) {
                    return res.status(404).send('Asset not found');
                }
                res.set('Content-Type', extension === '.ogg' ? 'audio/ogg' : 'image/webp');
                res.set('Cache-Control', 'public, max-age=86400');
                return res.sendFile(assetPath);
            } catch (e) {
                return res.status(400).send('Invalid asset path');
            }
        }
        if (!url) return res.status(400).send("Missing URL");
        try {
            const imageRes = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Referer': new URL(url).origin
                }
            });
            res.set('Content-Type', imageRes.headers['content-type']);
            res.set('Cache-Control', 'public, max-age=86400');
            res.send(Buffer.from(imageRes.data));
        } catch (e) {
            res.status(500).send("Image fetch failed");
        }
        return;
    }

    // --- JSON / ZIP ENDPOINT ---
    if (!file) return res.status(400).json({ error: "Bad Request: Filename required" });

    if (type === 'json' && ROLE_FILES.has(file)) {
        try {
            return res.json(buildRoleJson(req, file));
        } catch (e) {
            return res.status(500).json({ error: "Failed to build skin data" });
        }
    }

    const repo = type === 'json' ? 'HydraToolsBanner' : 'HydraSkin';
    const encodedFile = encodeURIComponent(file);
    const githubUrl = `https://api.github.com/repos/Derek200401/${repo}/contents/${encodedFile}?ref=main`;

    try {
        const response = await axios.get(githubUrl, {
            headers: {
                "Authorization": `Bearer ${GITHUB_TOKEN}`,
                "Accept": "application/vnd.github.raw",
                "User-Agent": "HydraToolsApp/1.0"
            },
            responseType: type === 'json' ? 'json' : 'arraybuffer'
        });

        if (type === 'json') {
            let jsonData = response.data;
            const proxyBase = `${req.protocol}://${req.get('host')}/api/download?type=zip&file=`;
            const imageProxyBase = `${req.protocol}://${req.get('host')}/api/download?type=image&url=`;

            for (const heroName of Object.keys(jsonData)) {
                const skins = jsonData[heroName];
                if (Array.isArray(skins)) {
                    for (const skin of skins) {
                        const skinName = skin.skin_name || skin.skinName || '';
                        if (!skinName) continue;
                        const filename = `${heroName} ${skinName}.zip`;
                        if (!skin.zip_url) skin.zip_url = `${proxyBase}${encodeURIComponent(filename)}`;
                        if (!skin.zip_fallback_url) skin.zip_fallback_url = `${proxyBase}${encodeURIComponent(filename)}`;
                        
                        // I-REDIRECT ANG MGA IMAGES SA RAILWAY PROXY
                        if (skin.portrait && !skin.portrait.includes('/api/download')) {
                            skin.portrait = `${imageProxyBase}${encodeURIComponent(skin.portrait)}`;
                        }
                        if (skin.splash && !skin.splash.includes('/api/download')) {
                            skin.splash = `${imageProxyBase}${encodeURIComponent(skin.splash)}`;
                        }
                        if (skin.tag_url && !skin.tag_url.includes('/api/download')) {
                            skin.tag_url = `${imageProxyBase}${encodeURIComponent(skin.tag_url)}`;
                        }
                        if (skin.icon && !skin.icon.includes('/api/download')) {
                            skin.icon = `${imageProxyBase}${encodeURIComponent(skin.icon)}`;
                        }
                        if (skin.skills) {
                            for (const skill of skin.skills) {
                                if (skill.skill_icon && !skill.skill_icon.includes('/api/download')) {
                                    skill.skill_icon = `${imageProxyBase}${encodeURIComponent(skill.skill_icon)}`;
                                }
                            }
                        }
                    }
                }
            }
            res.json(jsonData);
        } else {
            res.set('Content-Type', 'application/octet-stream');
            res.set('Content-Disposition', `attachment; filename="${file}"`);
            res.send(Buffer.from(response.data));
        }
    } catch (error) {
        res.status(404).json({ error: "File Not Found in Private Repo" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
