/**
 * Created by adventis on 3/17/18.
 */
var shell = require('shelljs');
var path = require('path');
var fs = require('fs');
var fs_extra = require('fs-extra');
var xcode = require('xcode');
var url = require('url');
xml2js = require('xml2js');
var plist = require('plist');
var sharp = require('sharp');
var stdio = require('stdio');
var xcode = require('xcode');
var sync = require('sync');
var deasync = require('deasync');


var ops = stdio.getopt({
    'appconfig': {key: 'c', args: 1, mandatory: true, description: 'Full path to config file'},
    'php': {key: 'p', args: 1, mandatory: true, description: 'Full path to PHP interpreter'},
    'screengenerator': {key: 's', args: 1, mandatory: true, description: 'Full path to screengenerator'},
    'full_create': {description: 'Create app, Install plugins, Update bundle'},
    'update_plugin': {description: 'Install/Update Plugins, Update bundle'},
    'update_bundle': {description: 'Update bundle'},

});

var appConfig = undefined;
var platforms = {};
var phpInterpreter = undefined;
var screengenerator = undefined;

main().then(result => {
    console.log("Finish generate project");
});

async function main() {
    var FULL_CREATE = false
    var UPDATE_PLUGIN = false
    var UPDATE_BUNDLE = false
    var BUILD_AFTER = true
    
    if (ops.appconfig) {
        FULL_CREATE = ops.full_create;
        UPDATE_PLUGIN = ops.update_plugin;
        UPDATE_BUNDLE = ops.update_bundle;
        phpInterpreter = ops.php;
        screengenerator = ops.screengenerator;
    }
    console.log(ops);
    var pathToConfig = ops.appconfig;
    if (!path.isAbsolute(pathToConfig)) {
        pathToConfig = path.join(__dirname, pathToConfig)
    }

    appConfig = require(pathToConfig);
    var appNameForOS = appConfig.name.split(" ").join('')
    var appRootPath = path.dirname(pathToConfig)
    var appBuildRootPath = path.join(appRootPath, "build")
// var appDestination = path.join(appBuildRootPath, appNameForOS)

    console.log(appBuildRootPath);

    createFolderIfNotExist(appBuildRootPath);


// Create separate project for each platform

    for (platform in appConfig.platforms) {
        var platformAppDirectory = path.join(appBuildRootPath, appConfig.platforms[platform]);
        console.log(platformAppDirectory);
        createFolderIfNotExist(platformAppDirectory);
        platforms[appConfig.platforms[platform]] = path.join(platformAppDirectory, appNameForOS)
    }

    console.log(FULL_CREATE);

    if (FULL_CREATE) {
    // Add projects
    console.log(appNameForOS);
        addProjects(appNameForOS)

    // setupConfig
        setupConfig(appConfig);

    // Copy icons
        await copyIcons(platforms, appRootPath);

    // Add platforms
        addPlatforms();

    // Copy resourcpyResources(appConfig, appRootPath, platforms)
        copyResources(appConfig, appRootPath, platforms)

        if(appConfig.splashscreen != undefined) {
            // Generate splashscreen
            await generateSplashscreens(appConfig, appRootPath);
        } else {
            // Copy splashscreen
            copyIOSSplashscreens();
        }
    }

    if (FULL_CREATE || UPDATE_PLUGIN) {
// Added plugins
// Please not if plugin has string variables you have to wrap it like "/"Some big string/""
//         removePlugins(["com.q.users.cordova"]);
        addPlugins();

    }
    if (FULL_CREATE || UPDATE_PLUGIN || UPDATE_BUNDLE) {
        //    update metadata
        updateMetadata(appConfig, platforms);
        //create bundle
        createBundle(appConfig, platforms)
        //create config.json file for main Q plugin
        copyQConfig(appConfig, platforms);
        // Create deploy config
        createDeployConfig(appConfig, platforms);
    }

    cordovaBuild(BUILD_AFTER,platforms)

    if (FULL_CREATE) {
        performManulaChanges(appConfig, platforms)
        cordovaBuild(BUILD_AFTER,platforms)
    }

    if (FULL_CREATE || UPDATE_PLUGIN || UPDATE_BUNDLE) {
        // Update name of app
        updateNameOfApp(appConfig, platforms)
    }

    // performManulaChanges(appConfig, platforms)
    // cordovaBuild(BUILD_AFTER,platforms)
}

function cordovaBuild(BUILD_AFTER,platforms) {
    if(BUILD_AFTER) {
        for(platform in platforms) {
            shell.cd(platforms[platform]);
            execWithLog('cordova build ' + platform);
        }
    }
}

function execWithLog(command) {
    console.log("Running "+command);
    console.log(shell.exec(command).stdout);
}

function writeXmlFile(xmlPath, parsedConfigFile) {
    var parser = new xml2js.Parser(), xmlBuilder = new xml2js.Builder();
    var xml = xmlBuilder.buildObject(parsedConfigFile);
    fs.writeFileSync(xmlPath, xml)
}

function readXmlFile(xmlPath) {
    var parser = new xml2js.Parser(), xmlBuilder = new xml2js.Builder();

    var globalResult = null
    var content = fs.readFileSync(xmlPath);
    parser.parseString(content, function (err, result) {
        globalResult =  result;
    });

    return globalResult
}

function addProjects(appNameForOS) {
    for(platform in platforms) {
        var pathFolder = path.join(platforms[platform])
        if (!fs.existsSync(pathFolder)) {
            execWithLog('cordova create ' + pathFolder + " " + appConfig.packageId[platform] + " " + appNameForOS);
        }
    }
}

function addPlatforms() {
    for(platform in platforms) {
        shell.cd(platforms[platform]);
        shell.exec('cordova platform add ' + platform).output;
    }
}

function removePlugins(removePlugins) {
    for(plugin in removePlugins) {
        for(platform in platforms) {
            var pathToApp = platforms[platform]
            shell.cd(pathToApp);
            command = generatePluginRemoveCL(removePlugins[plugin], pathToApp)
            shell.exec(command);
        }
    }
}

function addPlugins() {
    console.log("Add plugins")
    for(plugin in appConfig.plugins) {
        var pluginConfig = appConfig.plugins[plugin]

        for (platformIndex in pluginConfig.platforms) {
            var pathToApp = platforms[pluginConfig.platforms[platformIndex]];
            if(pathToApp == undefined)
                continue;

            var pluginOption = appConfig.plugins[plugin];
            shell.cd(pathToApp);
            console.log("Plugin "+plugin);
            command = generatePluginInstallCL(plugin, pluginOption, pathToApp)
            shell.exec(command).stdout;

            var platform = [pluginConfig.platforms[platformIndex]]
            if(pluginOption.patch != undefined) {
                for(file in pluginOption.patch[platform]) {
                    var patchObject = pluginOption.patch[platform][file];

                    for(filePath in patchObject.path) {
                        var pathToFileChange = path.join(pathToApp,patchObject.path[filePath]);

                        var content = fs.readFileSync(pathToFileChange, "utf-8");
                        content = content.replace(patchObject.find,patchObject.replace);
                        fs.writeFileSync(pathToFileChange, content)
                    }

                }
            }
        }
    }
}

function setupConfig(appConfig) {
    for(platform in platforms) {
        var pathFolder = path.join(platforms[platform])
        var config = readXmlFile(path.join(pathFolder, "config.xml"))

        // Setup name
        // config.widget.name[0] = appConfig.name

        if(platform == "android") {
            var platformConfig = config.widget.platform[0]

            // Setup allow-navigation
            platformConfig["allow-navigation"] = [{$: {href: "*"}}]

            if(appConfig.AndroidPreferences !== undefined) {
                platformConfig["preference"] = [];
                for (key in appConfig.AndroidPreferences) {
                    platformConfig["preference"].push({$:{ name:key, value:appConfig.AndroidPreferences[key]}})
                }
            }
            config.widget.platform[0] = platformConfig
        } else {
            var platformConfig = config.widget.platform[1]

            // Setup allow-navigation
            platformConfig["allow-navigation"] = [{$: {href: "*"}}]

            // Setup permission usage description for ios
            if(appConfig.iOSParametersInfoPlist !== undefined) {
                platformConfig["edit-config"] = []
            }
            for (key in appConfig.iOSParametersInfoPlist) {
                platformConfig["edit-config"].push({$:{ target:key, file:"*-Info.plist", mode:"merge"}, string: [appConfig.iOSParametersInfoPlist[key]]})
            }

            if(appConfig.iOSPreferences !== undefined) {
                platformConfig["preference"] = [];
                for (key in appConfig.iOSPreferences) {
                    platformConfig["preference"].push({$:{ name:key, value:appConfig.iOSPreferences[key]}})
                }
            }
            // console.log(platformConfig["edit-config"])
            config.widget.platform[1] = platformConfig
        }

        writeXmlFile(path.join(pathFolder, "config.xml"), config);
    }
}

function updateMetadata(appConfig, platforms) {
    for(platform in platforms) {
        var pathFolder = path.join(platforms[platform])
        var config = readXmlFile(path.join(pathFolder, "config.xml"))
        config.widget['$'].version = appConfig.versions[platform].version
        if(platform == "android") {
            config.widget['$']["android-versionCode"] = appConfig.versions[platform].code;
        } else {
            config.widget['$']["ios-CFBundleVersion"] = appConfig.versions[platform].code;
        }
        writeXmlFile(path.join(pathFolder, "config.xml"), config);
    }
}

function createDeployConfig(appConfig, platforms) {
    for(platform in platforms) {
        var pathFolder = path.join(platforms[platform], "platforms",platform)
        console.log(pathFolder);
        console.log("___");
        var fastlanePath = path.join(pathFolder, "fastlane");

        createFolderIfNotExist(fastlanePath)

        shell.cd(fastlanePath);

        var androidScreengrabScreenshots = "urls ";
        var iosScreenshots = "";
        if(appConfig.deploy.screenshots != undefined) {
            appConfig.deploy.screenshots.forEach(function(screen) {
                if(iosScreenshots.length > 0) {
                    androidScreengrabScreenshots += ","
                    iosScreenshots += ","
                }
                androidScreengrabScreenshots += screen.url
                iosScreenshots += "\"-init_url "+screen.url+"\""
            });
        }
        if(platform == "android") {
            var fastlaneExamplePath = path.join(__dirname, "fastlane_templates", "android");

            //Create release config
            var signingContent = "storeFile=../../../../../"+appConfig.signing.android.storeFile+"\n"+
                            "storePassword="+appConfig.signing.android.storePassword+"\n"+
                            "keyAlias="+appConfig.signing.android.keyAlias+"\n"+
                            "keyPassword="+appConfig.signing.android.keyPassword+"\n";
            fs.writeFileSync(path.join(pathFolder, "release-signing.properties"), signingContent)

            //Copy Appfile
            var appfileContent = fs.readFileSync(path.join(fastlaneExamplePath, "Appfile"), "utf-8");
            appfileContent = appfileContent.replace("<package_id>","\""+appConfig.packageId[platform]+"\"");
            fs.writeFileSync(path.join(fastlanePath, "Appfile"), appfileContent)
            //Copy Fastfile
            var fastfileContent = fs.readFileSync(path.join(fastlaneExamplePath, "Fastfile"), "utf-8");
            fastfileContent = fastfileContent.replace("<screenshots_array>","\""+androidScreengrabScreenshots+"\"");
            fs.writeFileSync(path.join(fastlanePath, "Fastfile"), fastfileContent)
            //Copy Screengrabline
            var screengrablineContent = fs.readFileSync(path.join(fastlaneExamplePath, "Screengrabline"), "utf-8");
            screengrablineContent = screengrablineContent.replace("<screenshots_string>","\""+androidScreengrabScreenshots+"\"")
            fs.writeFileSync(path.join(fastlanePath, "Screengrabline"), screengrablineContent)


            // Setup metadata
            var fastlaneMetadataPath = path.join(fastlanePath, "metadata");
            createFolderIfNotExist(fastlaneMetadataPath)
            var fastlaneMetadataAndroidPath = path.join(fastlaneMetadataPath, "android");
            createFolderIfNotExist(fastlaneMetadataAndroidPath)
            var fastlaneMetadataAndroidEnPath = path.join(fastlaneMetadataAndroidPath, "en-US");
            createFolderIfNotExist(fastlaneMetadataAndroidEnPath)
            var fastlaneMetadataAndroidChangelogsPath = path.join(fastlaneMetadataAndroidEnPath, "changelogs");
            createFolderIfNotExist(fastlaneMetadataAndroidChangelogsPath)

            fs.writeFileSync(path.join(fastlaneMetadataAndroidEnPath, "title.txt"), appConfig.displayName);
            fs.writeFileSync(path.join(fastlaneMetadataAndroidEnPath, "short_description.txt"), appConfig.deploy.shortDescription);
            fs.writeFileSync(path.join(fastlaneMetadataAndroidEnPath, "full_description.txt"), appConfig.deploy.description);
            fs.writeFileSync(path.join(fastlaneMetadataAndroidChangelogsPath, appConfig.versions.android.code+".txt"), appConfig.deploy.release_notes);
        } else {
            var fastlaneExamplePath = path.join(__dirname, "fastlane_templates", "ios");
            //Copy Appfile
            var appfileContent = fs.readFileSync(path.join(fastlaneExamplePath, "Appfile"), "utf-8");
            appfileContent = appfileContent.replace("<app_identifier>",appConfig.packageId[platform]);
            appfileContent = appfileContent.replace("<apple_id>",appConfig.signing[platform].appleId);
            appfileContent = appfileContent.replace("<itc_team_name>",appConfig.signing[platform].itc_team_name);
            fs.writeFileSync(path.join(fastlanePath, "Appfile"), appfileContent)
            //Copy Fastfile
            var fastfileContent = fs.readFileSync(path.join(fastlaneExamplePath, "Fastfile"), "utf-8");
            fastfileContent = fastfileContent.replace(/<project_name>/g, appConfig.name);
            fastfileContent = fastfileContent.replace(/<team_id>/g, appConfig.signing.ios.team_id);
            fs.writeFileSync(path.join(fastlanePath, "Fastfile"), fastfileContent)
            //Copy Snapfile
            var snapfileContent = fs.readFileSync(path.join(fastlaneExamplePath, "Snapfile"), "utf-8");
            snapfileContent = snapfileContent.replace(/<project_name>/g, appConfig.name);
            snapfileContent = snapfileContent.replace("<screenshots>", iosScreenshots);
            fs.writeFileSync(path.join(fastlanePath, "Snapfile"), snapfileContent)

            // Setup metadata
            var fastlaneMetadataPath = path.join(fastlanePath, "metadata");
            createFolderIfNotExist(fastlaneMetadataPath)
            var fastlaneMetadataEnPath = path.join(fastlaneMetadataPath, "en-US");
            createFolderIfNotExist(fastlaneMetadataEnPath)

            fs.writeFileSync(path.join(fastlaneMetadataEnPath, "name.txt"), appConfig.displayName);
            fs.writeFileSync(path.join(fastlaneMetadataEnPath, "promotional_text.txt"), appConfig.deploy.shortDescription);
            fs.writeFileSync(path.join(fastlaneMetadataEnPath, "description.txt"), appConfig.deploy.description);
            fs.writeFileSync(path.join(fastlaneMetadataEnPath, "keywords.txt"), appConfig.deploy.keywords);
            fs.writeFileSync(path.join(fastlaneMetadataEnPath, "privacy_url.txt"), appConfig.deploy.privacy_url);
            fs.writeFileSync(path.join(fastlaneMetadataEnPath, "support_url.txt"), appConfig.deploy.support_url);
            fs.writeFileSync(path.join(fastlaneMetadataEnPath, "subtitle.txt"), appConfig.deploy.subtitle);
            fs.writeFileSync(path.join(fastlaneMetadataEnPath, "release_notes.txt"), appConfig.deploy.release_notes);
        }
    }
}

function updateNameOfApp(appConfig, platforms) {
    for(platform in platforms) {
        var pathFolder = path.join(platforms[platform])

        // var config = readXmlFile(path.join(pathFolder, "config.xml"))
        // config.widget.name = appConfig.displayName;
        // writeXmlFile(path.join(pathFolder, "config.xml"), config);

        if(platform == "android") {
            var stringFilePath = path.join(pathFolder, "platforms", "android", "app", "src", "main", "res", "values", "strings.xml")
            var globalResult = readXmlFile(stringFilePath);
            for (item in globalResult.resources.string) {
                var itemContent = globalResult.resources.string[item];
                if(itemContent['$'].name == "app_name") {
                    itemContent['_'] = appConfig.displayName
                }
            }
            writeXmlFile(stringFilePath, globalResult);
        } else {
            var infoPlistFile = path.join(pathFolder, "platforms", "ios", appConfig.name, appConfig.name+"-Info.plist")
            var content = fs.readFileSync(infoPlistFile, "utf-8");
            var plistParsed = plist.parse(content);
            plistParsed.CFBundleDisplayName = appConfig.displayName;
            fs.writeFileSync(infoPlistFile, plist.build(plistParsed))
        }

    }
}


async function syncPromises(promisesArray) {
    return Promise.all(promisesArray)
}

async function copyIcons(platforms, appRootPath) {
    var originalIconPath = path.join(appRootPath, "icon.png")

    var androidIconSize = {
        "ldpi.png":"36x36",
        "mdpi.png":"48x48",
        "hdpi.png":"72x72",
        "xhdpi.png":"96x96",
        "xxhdpi.png":"144x144",
        "xxxhdpi.png":"192x192"
    };
    var iosIcons = {
        "icon-60@3x.png":"180:180",
        "icon-60.png":"60:60",
        "icon-60@2x.png":"120:120",
        "icon-76.png":"76:76",
        "icon-76@2x.png":"152:152",
        "icon-40.png":"40:40",
        "icon-40@2x.png":"80:80",
        "icon-40@3x.png":"120:120",
        "icon.png":"57:57",
        "icon@2x.png":"114:114",
        "icon-72.png":"72:72",
        "icon-72@2x.png":"144:144",
        "icon-small.png":"29:29",
        "icon-small@2x.png":"58:58",
        "icon-small@3x.png":"87:87",
        "icon-50.png":"50:50",
        "icon-50@2x.png":"100:100",
        "icon-20.png":"20:20",
        "icon-20@2x.png":"40:40",
        "icon-20@3x.png":"60:60",
        "icon-83.5@2x.png":"167:167",
        "icon-1024.png":"1024:1024"
    };
    // var iosIcons = {
    //         "icon-60@3x.png":"180:180",
    //         "icon-60.png":"60:60",
    //         "icon-60@2x.png":"120:120",
    //         "icon-76.png":"76:76",
    //         "icon-76@2x.png":"152:152",
    //         "icon-40.png":"40:40",
    //         "icon-40@2x.png":"80:80",
    //         "icon-40@3x.png":"120:120",
    //         "icon.png":"57:57",
    //         "icon@2x.png":"114:114",
    //         "icon-72.png":"72:72",
    //         "icon-72@2x.png":"144:144",
    //         "icon-small.png":"29:29",
    //         "icon-small@2x.png":"58:58",
    //         "icon-small@3x.png":"87:87",
    //         "icon-50.png":"50:50",
    //         "icon-50@2x.png":"100:100",
    //         "icon-20.png":"20:20",
    //         "icon-20@2x.png":"40:40",
    //         "icon-20@3x.png":"60:60",
    //         "icon-83.5@2x.png":"167:167",
    //         "icon-1024.png":"1024:1024"
    // };

    for(platform in platforms) {
        var pathFolder = path.join(platforms[platform])
        var pathToResource = path.join(pathFolder, "res")

        var platformPath = path.join(pathToResource, "icon", platform);

        removeDir(path.join(pathToResource, "icon"))
        mkDir(path.join(platformPath))

        var filePromises = [];
        if(platform == "android") {
            for(iconSize in androidIconSize) {
                var size = parseInt(androidIconSize[iconSize].split("x")[0], 10);
                filePromises.push(sharp(originalIconPath).resize(size, size).toFile(path.join(platformPath, iconSize)));
            }
        } else {
            for(iconSize in iosIcons) {
                var size = parseInt(iosIcons[iconSize].split(":")[0], 10);
                if(size == 1024) {
                    filePromises.push(sharp(originalIconPath).jpeg().resize(size, size).toFile(path.join(platformPath, iconSize.replace(".png", ".jpeg"))));
                    // filePromises.push(sharp(originalIconPath).resize(size, size).background({r: 255, g: 255, b: 255, alpha: 1}).toFile(path.join(platformPath, iconSize)));
                } else {
                    filePromises.push(sharp(originalIconPath).resize(size, size).toFile(path.join(platformPath, iconSize)));
                }
            }
        }

        await syncPromises(filePromises);

        removeDir(path.join(pathToResource, "screen"))
        copyRecursiveSync(path.join(appRootPath, "screen"), pathToResource)

        var config = readXmlFile(path.join(pathFolder, "config.xml"))
        // var icons = getAllFiles(path.join(appRootPath, "icon", platform))
        var icons = getAllFiles(platformPath)
        if(platform == "android") {
            // Icons
            var configAndroidIcons = [];
            for(iconIndex in icons) {
                filename = icons[iconIndex];
                var density = filename.replace(".png", "");
                if(density != undefined) {
                    configAndroidIcons.push({ '$': { src:path.join("res", "icon", "android", filename), density:density}})
                }
            }
            config.widget.platform[0].icon = configAndroidIcons

        } else {
            // Icons
            var configIOSIcons = [];
            for(iconIndex in icons) {
                filename = icons[iconIndex];
                if(iosIcons[filename] != undefined) {
                    var size = iosIcons[filename].split(":");
                    configIOSIcons.push({ '$': { src:path.join("res", "icon", "ios", filename), width:size[0], height:size[1]}})
                }
            }
            config.widget.platform[1].icon = configIOSIcons
        }
        writeXmlFile(path.join(pathFolder, "config.xml"), config);
    }
}

async function generateSplashscreens(appConfig, appRootPath) {
    console.log("Generate Splashscreens");
    var originalIconPath = path.join(appRootPath, "icon.png")

    var iosSplashscreens = {
        "Default-568h@2x~iphone.png":"640:1136",
        "Default-667h.png":"750:1334",
        "Default-736h.png":"1242:2208",
        "Default-2436h.png":"1125:2436",
        "Default@2x~iphone.png":"640:960",
        "Default~iphone.png":"320:480",
        "Default-Landscape-736h.png":"2208:1242",
        "Default-Landscape-2436h.png":"2436:1125",
        "Default-Landscape@2x~ipad.png":"2048:1536",
        "Default-Landscape~ipad.png":"1024:768",
        "Default-Portrait@2x~ipad.png":"1536:2048",
        "Default-Portrait~ipad.png":"768:1024"
    }

    var tempSourceDir = path.join(__dirname, "tmp_screenshot_in");
    removeDir(tempSourceDir);
    mkDir(tempSourceDir);

    for(platform in platforms) {
        var pathFolder = path.join(platforms[platform])
        if(platform == "android") {
           
        } else {
           for (screenshot in iosSplashscreens) {
               var name = screenshot;
               var width = parseInt(iosSplashscreens[screenshot].split(":")[0], 10);
               var height = parseInt(iosSplashscreens[screenshot].split(":")[1], 10);
               
               var templatePath = path.join(tempSourceDir, "tmp_template.png");
               // Generate template path
               await sharp({
                    create: {
                    width: width,
                    height: height,
                    channels: 4,
                    background: { r: 255, g: 255, b: 255, alpha: 0 }
                    }
                })
                .png()
                .toFile(templatePath);

                var iconWidth = width*0.5
                var x = width*0.25
                var y = height/2 - iconWidth/2
                if(height < width) {
                    iconWidth = height*0.5
                    x = width/2 - iconWidth/2
                    y = height*0.25
                }
                var iconHeight = iconWidth
                
                var templateConfig = {
                    "screenshot": {
                        "x":x,
                        "y":y,
                        "width":iconWidth,
                        "height":iconHeight
                    }
                }

                var templateConfigPath = path.join(tempSourceDir, "tmp_config.json");
                fs.writeFileSync(templateConfigPath, JSON.stringify(templateConfig));

                var outputCordovaPath = path.join(pathFolder, "res", "screen", "ios", name);
                var outputIOSPath = path.join(pathFolder, "platforms", "ios", appConfig.name.replace(/ /g, '\\ '), "Images.xcassets", "LaunchImage.launchimage", name);
                
                var command = phpInterpreter+" "+screengenerator+" -t \""+templatePath+"\" -x \""+templateConfigPath+"\" -r png -c "+"\""+appConfig.splashscreen.background+"\""+" -s \""+originalIconPath+"\" -o "+width+"x"+height
                command += " -d \""+outputIOSPath+"\"";          
                
                shell.exec(command);
           }
        }
    }
    removeDir(tempSourceDir);
}



function copyIOSSplashscreens() {
    for(platform in platforms) {
        if(platform == "ios") {
            var pathFolder = path.join(platforms[platform])
            var pathToResource = path.join(pathFolder, "res")
            //Splashscreens
            var pathToSplashscreen = path.join(pathToResource, "screen", "ios")
            if (fs.existsSync(pathToSplashscreen)) {

                var files = fs.readdirSync(pathToSplashscreen).forEach(file => {
                        // if(iosSplashscreens[file] !== undefined) {
                        // var command = "cp " + path.join(pathToSplashscreen, file) + " " + path.join(pathFolder, "platforms", "ios", appConfig.name.replace(/ /g, '\\ '), "Images.xcassets", "LaunchImage.launchimage", iosSplashscreens[file])
                        var command = "cp " + path.join(pathToSplashscreen, file) + " " + path.join(pathFolder, "platforms", "ios", appConfig.name.replace(/ /g, '\\ '), "Images.xcassets", "LaunchImage.launchimage", file);
                        console.log(command)
                        shell.exec(command);
                    // }
                });
            }
        }
    }
}

function getAllFiles(pathFolder) {
    return fs.readdirSync(pathFolder)
}

function renameFiles(pathFolder, renameMap) {
    var files = fs.readdirSync(pathFolder).forEach(file => {
            if(renameMap[file] !== undefined) {
                shell.exec("mv " + path.join(pathFolder,file) + " " + path.join(pathFolder,renameMap[file]));
            }
    });
}

function removeDir(src) {
    shell.exec("rm -r "+ src);
}

function mkDir(src) {
    shell.exec("mkdir -p "+ src);
}

function copyRecursiveSync(src, dest) {
    if (!fs.existsSync(dest)) {
        shell.exec("mkdir -p "+dest);
    }
    shell.exec("cp -r "+ src + " " +dest);
}

function createGitPullPath(urlRepo, login, password) {
    var urlRepoParsed = url.parse(urlRepo, true);
    if(login == undefined) {
        return urlRepoParsed.protocol + "//"+urlRepoParsed.host+urlRepoParsed.pathname
    } else {
        return urlRepoParsed.protocol + "//" + login+":"+password+"@"+urlRepoParsed.host+urlRepoParsed.pathname
    }

}

function createHgPullPath(urlRepo, login, password) {
    var urlRepoParsed = url.parse(urlRepo, true);
    return urlRepoParsed.protocol + "//" + login+":"+password+"@"+urlRepoParsed.host+urlRepoParsed.pathname
}

function createBundle(appConfig, platforms) {
    if (appConfig.Bundle == undefined) return;
    if (appConfig.Bundle.Q != undefined) {
        if (appConfig.Bundle.Q.webProjectPath == undefined || appConfig.Bundle.Q.webProjectPath.length == 0) return;

        var appPath = path.join(appConfig.Bundle.Q.webProjectPath);
        var qPath = path.join(appConfig.Bundle.Q.QProjectPath);
        var installScript = path.join(appPath, "/scripts/Q/install.php");
        var bundleScript = path.join(appPath, "/scripts/Q/bundle.php");

        // Update Q repo
        var pluginsPath = path.join(qPath, "plugins");
        var plugins = getDirectories(pluginsPath);

        for (var dirIndex in plugins) {
            var pluginDir = plugins[dirIndex]
            shell.cd(pluginDir);
            stdout = shell.exec('hg paths', {silent: true}).stdout;
            var pluginUrl = stdout.split("=")[1].trim()
            shell.exec("hg pull -u " + createHgPullPath(pluginUrl, appConfig.Bundle.Q.login, appConfig.Bundle.Q.password));
            shell.exec("hg update");
        }

        // Update repo
        shell.cd(appPath);
        shell.exec("hg pull -u " + createHgPullPath(appConfig.Bundle.Q.url, appConfig.Bundle.Q.login, appConfig.Bundle.Q.password));
        shell.exec("hg update");

        var command = "php " + installScript + "  --all";
        console.log(command);
        execWithLog(command);
        for (platform in platforms) {
            var pathFolder = path.join(platforms[platform], "www/Bundle");
            createFolderIfNotExist(pathFolder);
            execWithLog("php " + bundleScript + " " + pathFolder);
            if (platform === "android") {
                var androidPathFolder = path.join(platforms[platform], "platforms/android/app/src/main/assets/", "www/Bundle");
                createFolderIfNotExist(androidPathFolder);
                var command = "php " + bundleScript + " " + androidPathFolder;
                console.log(command);
                execWithLog(command);
            } else if (platform === "ios") {
                var iosPathFolder = path.join(platforms[platform], "platforms/ios/", "www/Bundle");
                createFolderIfNotExist(iosPathFolder);
                var command = "php " + bundleScript + " " + iosPathFolder;
                console.log(command);
                execWithLog(command);
            }
        }
    } else if(appConfig.Bundle.Direct != undefined) {
        console.log("Direct bundle")
        for (platform in platforms) {
            var pathFolder = path.join(platforms[platform], "www");

            shell.exec("cd "+pathFolder)
            shell.exec("pwd").output;
            if(appConfig.Bundle.Direct.type =="git") {
                var tempFolder = path.join(pathFolder, "tmp");
                removeDir(tempFolder)
                removeDir(pathFolder+"/*")
                var command = "git clone " + ((appConfig.Bundle.Direct.branch !== undefined) ? " -b "+appConfig.Bundle.Direct.branch+" ":" -b master ")+ createGitPullPath(appConfig.Bundle.Direct.url, appConfig.Bundle.Direct.login, appConfig.Bundle.Direct.password, appConfig.Bundle.Direct.branch) + " "+tempFolder
                console.log(command);
                shell.exec(command)
                removeDir(path.join(tempFolder, ".git"))
                shell.exec("cp -r -v "+tempFolder+"/* "+pathFolder);
                removeDir(tempFolder)
                // shell.exec("mv -f -v "+tempFolder+" "+pathFolder);
            } else if(appConfig.Bundle.Direct.type =="hg") {
                var tempFolder = path.join(pathFolder, "tmp");
                removeDir(tempFolder)
                var command = "hg clone "+createHgPullPath(appConfig.Bundle.Direct.url, appConfig.Bundle.Direct.login, appConfig.Bundle.Direct.password)+" "+((appConfig.Bundle.Direct.branch !== undefined) ? " -r "+appConfig.Bundle.Direct.branch+" ":" -r master ")+" "+tempFolder
                console.log(command);
                shell.exec(command)
                removeDir(path.join(tempFolder, ".hg"))
                shell.exec("cp -r -v "+tempFolder+"/* "+pathFolder);
                removeDir(tempFolder)
            }
            console.log("Cordova folder:" +platforms[platform])
            shell.exec("cd "+platforms[platform]+" && cordova prepare");
        }
    }
}

function getDirectories(srcpath) {
    return fs.readdirSync(srcpath)
            .map(file => path.join(srcpath, file)).filter(path => fs.statSync(path).isDirectory());
}

function copyQConfig(appConfig, platforms) {
    var config = createQConfigFile(appConfig);

    var configFilename = "config.json"
    for(platform in platforms) {
        var pathFolder = path.join(platforms[platform])
        if (fs.existsSync(pathFolder)) {
            fs_extra.writeJsonSync(path.join(pathFolder, configFilename), config)
            if(platform === "android") {
                fs_extra.writeJsonSync(path.join(pathFolder, "platforms/android/app/src/main/assets/", configFilename), config)
            } else if(platform === "ios") {
                var iosResourcePath = path.join(pathFolder, "platforms/ios/", appConfig.name, "Resources");
                createFolderIfNotExist(iosResourcePath);
                fs_extra.writeJsonSync(path.join(iosResourcePath, configFilename), config)
                var projectPath = path.join(pathFolder, '/platforms/ios/', appConfig.name+'.xcodeproj/project.pbxproj');
                var proj = new xcode.project(projectPath);
                var proj = new xcode.project(projectPath);
                proj = proj.parseSync();
                proj.addResourceFile(configFilename);
                fs.writeFileSync(projectPath, proj.writeSync());
            }
        }
    }
}

function createFolderIfNotExist(pathFolder) {
    if (!fs.existsSync(pathFolder)){
        console.log("MkDir "+pathFolder);
        fs.mkdirSync(pathFolder);
    }
}

function createQConfigFile(appConfig) {
    var config = {};
    config.Q = {};
    config.Q.cordova = {};
    var mainConfig = config.Q.cordova;

    mainConfig.cacheBaseUrl = appConfig.cacheBaseUrl;
    mainConfig.pathToBundle = "www/Bundle";
    mainConfig.injectCordovaScripts = true;
    mainConfig.bundleTimestamp = Math.floor(Date.now() / 1000);
    mainConfig.enableLoadBundleCache = true;
    mainConfig.pingUrl = appConfig.baseUrl;
    mainConfig.url = appConfig.baseUrl;
    mainConfig.baseUrl = appConfig.baseUrl;
    mainConfig.openUrlScheme = appConfig.openUrlScheme;
    mainConfig.userAgentSuffix = appConfig.userAgentSuffix;
    mainConfig.applicationKey = appConfig.applicationKey;

    return config
}

function copyResources(appConfig, appRootPath, platforms) {
    console.log("Copy Resources")
    for(fileIndex in appConfig.resources) {
        var resource = appConfig.resources[fileIndex]
        var sourceFilePath = path.join(appRootPath, resource.path);

        for(platform in resource.platforms) {
            var pathToPlatform = platforms[resource.platforms[platform]]
            var isAvailablePlatform = pathToPlatform != undefined
            if(isAvailablePlatform) {
                var destinationFilePath = path.join(pathToPlatform, path.basename(sourceFilePath));
                if(resource.to != undefined) {
                    destinationFilePath = path.join(pathToPlatform, resource.to, path.basename(sourceFilePath));
                }
                // console.log("Copy "+sourceFilePath+ " TO "+destinationFilePath);
                fs_extra.copySync(sourceFilePath, destinationFilePath);
                // fs.createReadStream(sourceFilePath).pipe(fs.createWriteStream(destinationFilePath));
            }
        }

    }
}

function generatePluginRemoveCL(pluginName, pathToApp) {
    var cl = 'cordova plugin remove '+pluginName

    // cl += " --nosave "
    cl += " --verbose "

    return cl
}

function generatePluginInstallCL(pluginId, pluginOption, pathToApp) {
    var cl = 'cordova plugin add '

    if (pluginOption.git != undefined) {
        cl += " "+pluginOption.git
    } else if(pluginOption.pluginId != undefined) {
        cl += " "+pluginOption.pluginId
    }

    // cl += " --nosave "
    cl += " --verbose "

    if(pluginOption.variables !== undefined) {
        for (variable in pluginOption.variables) {
            cl += " --variable "+variable+"="+pluginOption.variables[variable]
        }
    }

    if(pluginOption.flags !== undefined) {
        for (flag in pluginOption.flags) {
            cl += " "+pluginOption.flags[flag]+" "
        }
    }
    return cl
}

function generatePluginInstallViaPlugman(pluginOption, appDirectory) {
    var commands = [];
    for(platformIndex in pluginOption.platforms) {
        var platform = pluginOption.platforms[platformIndex];
        // plugman install --platform <ios|android|blackberry10|wp8> --project <directory> --plugin <name|url|path> [--plugins_dir <directory>] [--www <directory>] [--variable <name>=<value> [--variable <name>=<value> ...]]
        var cl = 'plugman install --platform '+platform+" --project "+appDestination

        if (pluginOption.git != undefined) {
            cl += " --plugin "+pluginOption.git
        }

        if(pluginOption.variables !== undefined) {
            for (variable in pluginOption.variables) {
                cl += " --variable "+variable+"="+pluginOption.variables[variable]
            }
        }

        commands.push(cl)
    }

    return commands
}

async function performManulaChanges(appConfig, platforms) {
    for(platform in platforms) {
        var pathFolder = path.join(platforms[platform])
        if(platform == "android") {

        } else {

            // Add legacy build mode
            // var legacyWorkspaceSettingsPath = path.join(pathFolder, "platforms", "ios", appConfig.name+".xcworkspace","xcshareddata","WorkspaceSettings.xcsettings");
            // fs.writeFileSync(legacyWorkspaceSettingsPath, '<?xml version="1.0" encoding="UTF-8"?>\n'+
            // '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'+
            // '<plist version="1.0">\n'+
            // '<dict>\n'+
            // '<key>BuildSystemType</key>\n'+
            // '<string>Original</string>\n'+
            // '</dict>\n'+
            // '</plist>');

            // var userLegacyWorkspaceSettingsPath = path.join(pathFolder, "platforms", "ios", appConfig.name+".xcworkspace","xcuserdata",require("os").userInfo().username+".xcuserdatad","WorkspaceSettings.xcsettings");
            // if (fs.existsSync(userLegacyWorkspaceSettingsPath)) {
            //     fs.writeFileSync(userLegacyWorkspaceSettingsPath, '<?xml version="1.0" encoding="UTF-8"?>\n'+
            //     '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'+
            //     '<plist version="1.0">\n'+
            //     '<dict>\n'+
            //         '<key>BuildLocationStyle</key>\n'+
            //         '<string>UseAppPreferences</string>\n'+
            //         '<key>CustomBuildLocationType</key>\n'+
            //         '<string>RelativeToDerivedData</string>\n'+
            //         '<key>DerivedDataLocationStyle</key>\n'+
            //         '<string>Default</string>\n'+
            //         '<key>EnabledFullIndexStoreVisibility</key>\n'+
            //         '<false/>\n'+
            //         '<key>IssueFilterStyle</key>\n'+
            //         '<string>ShowActiveSchemeOnly</string>\n'+
            //         '<key>LiveSourceIssuesEnabled</key>\n'+
            //         '<true/>\n'+
            //     '</dict>\n'+
            //     '</plist>')
            // }

            // Run pod install
            console.log("Pod install");
            var podfilePath = path.join(pathFolder, "platforms", "ios");
            execWithLog("cd "+podfilePath+" && pwd && pod install");

            // Add GoogleService-Info.plist file
            var projectName = appConfig.name;
            var googleServicePath = path.join(pathFolder, "platforms", "ios","GoogleService-Info.plist");
            var projectPath = path.join(pathFolder, "platforms", "ios", projectName+".xcodeproj","project.pbxproj");
            var proj = new xcode.project(projectPath);
            proj = proj.parseSync();
            proj.addResourceFile(googleServicePath);
            fs.writeFileSync(projectPath, proj.writeSync());
            

            // Add CodeSign to Release
            var proj = new xcode.project(projectPath);
            proj = proj.parseSync();
            var udid = proj.getFirstTarget().uuid
            var pbxBuildConfigurationSection = proj.pbxXCBuildConfigurationSection()
            for (key in pbxBuildConfigurationSection){
                var newKey = key;
                if(pbxBuildConfigurationSection[key].name == "Release") {
                    pbxBuildConfigurationSection[key].buildSettings['CODE_SIGN_IDENTITY'] = "\"iPhone Developer\"";
                    break;
                }
            }
            fs.writeFileSync(projectPath, proj.writeSync());

            var proj = new xcode.project(projectPath);
            proj = proj.parseSync();
            // Modify project structure to support automatic_code_signing fastlane plugin
            var ROOT_DIR = pathFolder;
            if(ROOT_DIR.substr(0, 1) === '/' && fs.existsSync(ROOT_DIR + "/platforms/ios")) {
                var srcFile = path.join(ROOT_DIR, "platforms", "ios",projectName+".xcodeproj","project.pbxproj");
                var projectPbxproj = fs.readFileSync(srcFile, "utf8");
            
                if(projectPbxproj.indexOf("TargetAttributes") === -1) {
                    console.log("Adding TargetAttributes to pbxproj");
                    var udid = proj.getFirstTarget().uuid
                    var pbxBuildConfigurationSection = proj.pbxXCBuildConfigurationSection()
            
                    // var targetAttributes = "\n\t\t\t\tTargetAttributes = {\n\t\t\t\t\t1D6058900D05DD3D006BFB54 = {\n\t\t\t\t\t\tDevelopmentTeam = F72EKUASP5;\n\t\t\t\t\t\tSystemCapabilities = {\n\t\t\t\t\t\t\tcom.apple.Push = {\n\t\t\t\t\t\t\t\tenabled = 1;\n\t\t\t\t\t\t\t};\n\t\t\t\t\t\t};\n\t\t\t\t\t};\n\t\t\t\t};";
                    var targetAttributes = "\n\t\t\t\tTargetAttributes = {\n\t\t\t\t\t"+udid+" = {\n\t\t\t\t\t\tDevelopmentTeam = "+appConfig.signing.ios.team_id+";\n\t\t\t\t\t\t\n\t\t\t\t\tProvisioningStyle = Automatic;\n\t\t\t\t\t\t\n\t\t\t\t\t};\n\t\t\t\t};";
                

                    var searchString = "LastUpgradeCheck = 510;";
                    var lastUpgradeCheckIndex = projectPbxproj.indexOf(searchString);
            
                    projectPbxproj = projectPbxproj.substr(0, lastUpgradeCheckIndex + searchString.length) + targetAttributes + projectPbxproj.substr(lastUpgradeCheckIndex + searchString.length);
                }
            
                fs.writeFileSync(srcFile, projectPbxproj);
            }

            // Add Targer For Screenshot Generator

            var fastlaneFolderPath = path.join(pathFolder, "platforms", "ios","QFastlaneUITests");
            mkDir(fastlaneFolderPath);

            // Write Info.plist
            var fastlaneInfoPlist = path.join(fastlaneFolderPath,"Info.plist")
            fs.writeFileSync(fastlaneInfoPlist, '<?xml version="1.0" encoding="UTF-8"?>\n'+
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'+
            '<plist version="1.0">\n'+
            '<dict>\n'+
            '<key>CFBundleDevelopmentRegion</key>\n'+
            '<string>$(DEVELOPMENT_LANGUAGE)</string>\n'+
            '<key>CFBundleExecutable</key>\n'+
            '<string>$(EXECUTABLE_NAME)</string>\n'+
            '<key>CFBundleIdentifier</key>\n'+
            '<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>\n'+
            '<key>CFBundleInfoDictionaryVersion</key>\n'+
            '<string>6.0</string>\n'+
            '<key>CFBundleName</key>\n'+
            '<string>$(PRODUCT_NAME)</string>\n'+
            '<key>CFBundlePackageType</key>\n'+
            '<string>BNDL</string>\n'+
            '<key>CFBundleShortVersionString</key>\n'+
            '<string>1.0</string>\n'+
            '<key>CFBundleVersion</key>\n'+
            '<string>1</string>\n'+
            '</dict>\n'+
            '</plist>\n');
            // proj.addResourceFile(fastlaneInfoPlist);

            // Rename QFastlaneUITests_example
            var proj = new xcode.project(projectPath);
            proj = proj.parseSync();
            var templateQFastlaneUITest = path.join(fastlaneFolderPath,"QFastlaneUITests_example.swift")
            var qFastlaneUITest = path.join(fastlaneFolderPath,"QFastlaneUITests.swift")
            shell.exec("mv "+templateQFastlaneUITest+" "+qFastlaneUITest)

            // var qFastlaneUITestRef = proj.addSourceFile(qFastlaneUITest);
            var qFastlaneUITestRef = addBuildFile(proj,qFastlaneUITest);
            
            var snapshotHelper = path.join(fastlaneFolderPath,"SnapshotHelper.swift")
            var snapshotHelperRef = addBuildFile(proj,snapshotHelper);

            var fastlaneGroup = proj.addPbxGroup([
                fastlaneInfoPlist,
                qFastlaneUITest,
                snapshotHelper
            ],"QFastlaneUITests","QFastlaneUITests");

            // var key = proj.pbxCreateGroupWithType("CustomTemplate", undefined, 'CustomTemplate')
            var groups = proj.getPBXObject("PBXGroup");
            var groupKey = undefined;
            for (key in groups) {
                if ('CustomTemplate' == groups[key].name) {
                    groupKey = key
                    var customGroup = groups[key]
                }
            }
    
            proj.addToPbxGroup(fastlaneGroup.uuid, groupKey);

            // proj.addTarget("QFastlaneUITests", "ui_testing","QFastlaneUITests");
            files = [qFastlaneUITestRef.uuid, snapshotHelperRef.uuid];//
            var uiTarget = addUITestTarget(proj,"QFastlaneUITests","QFastlaneUITests", files);

            // Add to workspace
            var workspacePath = path.join(pathFolder, "platforms", "ios", projectName+".xcworkspace", "xcshareddata","xcschemes",projectName+".xcscheme");
            var workspaceContent = readXmlFile(workspacePath)

            var testable = {}

            var testableReference = {};
            testableReference['$'] = {skipped: "NO"};
            var buildableReference = {}
            buildableReference['$'] = {
                BlueprintIdentifier: uiTarget.uuid,
                BlueprintName:"QFastlaneUITests",
                BuildableIdentifier: "primary",
                BuildableName:"QFastlaneUITests.xctest",
                ReferencedContainer:"container:"+projectName+".xcodeproj"
            };
            testableReference['BuildableReference'] = [buildableReference];

            testable["TestableReference"] = testableReference

            workspaceContent.Scheme.TestAction[0].Testables.push(
                testable
            )
            writeXmlFile(workspacePath, workspaceContent);

            
            fs.writeFileSync(projectPath, proj.writeSync());
        }
    }
}

function addBuildFile(project, path, opt, group) {
        var file;
        if (group) {
            file = project.addFile(path, group, opt);
        }
        else {
            file = project.addPluginFile(path, opt);
        }
    
        if (!file) return false;
    
        file.target = opt ? opt.target : undefined;
        file.uuid = project.generateUuid();
    
        project.addToPbxBuildFileSection(file);        // PBXBuildFile
        // this.addToPbxSourcesBuildPhase(file);       // PBXSourcesBuildPhase
    
        return file;
}

function addUITestTarget(project, name, subfolder, files) {
        // Setup uuid and name of new target
        var targetUuid = project.generateUuid(),
            targetType = "ui_testing",
            targetSubfolder = subfolder || name,
            targetName = name.trim();

        var productType = 'com.apple.product-type.bundle.ui-testing'
    
        // Check type against list of allowed target types
        if (!targetName) {
            throw new Error("Target name missing.");
        }
    
        // Check type against list of allowed target types
        if (!targetType) {
            throw new Error("Target type missing.");
        }
    
        // Build Configuration: Create
        var buildConfigurationsList = [
            {
                isa: 'XCBuildConfiguration',
                buildSettings: {
                    ALWAYS_SEARCH_USER_PATHS: 'NO',
				    CLANG_ANALYZER_NONNULL: 'YES',
				    CLANG_ANALYZER_NUMBER_OBJECT_CONVERSION: 'YES_AGGRESSIVE',
				    CLANG_CXX_LANGUAGE_STANDARD: '"gnu++14"',
				    CLANG_CXX_LIBRARY: '"libc++"',
				    CLANG_ENABLE_OBJC_WEAK: 'YES',
				    CLANG_WARN_BLOCK_CAPTURE_AUTORELEASING: 'YES',
				    CLANG_WARN_COMMA: 'YES',
				    CLANG_WARN_DEPRECATED_OBJC_IMPLEMENTATIONS: 'YES',
				    CLANG_WARN_DIRECT_OBJC_ISA_USAGE: 'YES_ERROR',
				    CLANG_WARN_DOCUMENTATION_COMMENTS: 'YES',
				    CLANG_WARN_INFINITE_RECURSION: 'YES',
				    CLANG_WARN_NON_LITERAL_NULL_CONVERSION: 'YES',
				    CLANG_WARN_OBJC_IMPLICIT_RETAIN_SELF: 'YES',
				    CLANG_WARN_OBJC_LITERAL_CONVERSION: 'YES',
				    CLANG_WARN_OBJC_ROOT_CLASS: 'YES_ERROR',
				    CLANG_WARN_RANGE_LOOP_ANALYSIS: 'YES',
				    CLANG_WARN_STRICT_PROTOTYPES: 'YES',
				    CLANG_WARN_SUSPICIOUS_MOVE: 'YES',
				    CLANG_WARN_UNGUARDED_AVAILABILITY: 'YES_AGGRESSIVE',
				    CLANG_WARN_UNREACHABLE_CODE: 'YES',
				    CODE_SIGN_IDENTITY: '"iPhone Developer"',
				    CODE_SIGN_STYLE: 'Automatic',
				    COPY_PHASE_STRIP: 'NO',
				    DEBUG_INFORMATION_FORMAT: 'dwarf',
				    DEVELOPMENT_TEAM: 'U6J99X5R3S',
				    ENABLE_STRICT_OBJC_MSGSEND: 'YES',
				    ENABLE_TESTABILITY: 'YES',
				    GCC_C_LANGUAGE_STANDARD: 'gnu11',
				    GCC_DYNAMIC_NO_PIC: 'NO',
				    GCC_NO_COMMON_BLOCKS: 'YES',
                    GCC_OPTIMIZATION_LEVEL: '0',
                    GCC_PREPROCESSOR_DEFINITIONS: ['"DEBUG=1"', '"$(inherited)"'],
				    GCC_WARN_64_TO_32_BIT_CONVERSION: 'YES',
				    GCC_WARN_ABOUT_RETURN_TYPE: 'YES_ERROR',
                    GCC_WARN_UNINITIALIZED_AUTOS: 'YES_AGGRESSIVE',
                    INFOPLIST_FILE: path.join(targetSubfolder, 'Info.plist'),
                    IPHONEOS_DEPLOYMENT_TARGET: '12.1',
                    LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @loader_path/Frameworks"',
				    MTL_ENABLE_DEBUG_INFO: 'INCLUDE_SOURCE',
				    MTL_FAST_MATH: 'YES',
                    PRODUCT_BUNDLE_IDENTIFIER: '"com.qbix.ui-test.'+targetName+'"',
                    PRODUCT_NAME: '"$(TARGET_NAME)"',
				    SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'DEBUG',
				    SWIFT_OPTIMIZATION_LEVEL: '"-Onone"',
				    SWIFT_VERSION: '4.2',
				    TARGETED_DEVICE_FAMILY: '"1,2"',
				    TEST_TARGET_NAME : project.productName,
                },
                name: 'Debug'
            },
            {
                isa: 'XCBuildConfiguration',
                buildSettings: {
                    ALWAYS_SEARCH_USER_PATHS: 'NO',
                    CLANG_ANALYZER_NONNULL: 'YES',
                    CLANG_ANALYZER_NUMBER_OBJECT_CONVERSION: 'YES_AGGRESSIVE',
                    CLANG_CXX_LANGUAGE_STANDARD: '"gnu++14"',
                    CLANG_CXX_LIBRARY: '"libc++"',
                    CLANG_ENABLE_OBJC_WEAK: 'YES',
                    CLANG_WARN_BLOCK_CAPTURE_AUTORELEASING: 'YES',
                    CLANG_WARN_COMMA: 'YES',
                    CLANG_WARN_DEPRECATED_OBJC_IMPLEMENTATIONS: 'YES',                        
                    CLANG_WARN_DIRECT_OBJC_ISA_USAGE: 'YES_ERROR',
                    CLANG_WARN_DOCUMENTATION_COMMENTS: 'YES',
                    CLANG_WARN_INFINITE_RECURSION: 'YES',
                    CLANG_WARN_NON_LITERAL_NULL_CONVERSION: 'YES',
                    CLANG_WARN_OBJC_IMPLICIT_RETAIN_SELF: 'YES',
                    CLANG_WARN_OBJC_LITERAL_CONVERSION: 'YES',
                    CLANG_WARN_OBJC_ROOT_CLASS: 'YES_ERROR',
                    CLANG_WARN_RANGE_LOOP_ANALYSIS: 'YES',
                    CLANG_WARN_STRICT_PROTOTYPES: 'YES',
                    CLANG_WARN_SUSPICIOUS_MOVE: 'YES',
                    CLANG_WARN_UNGUARDED_AVAILABILITY: 'YES_AGGRESSIVE',
                    CLANG_WARN_UNREACHABLE_CODE: 'YES',
                    CODE_SIGN_IDENTITY: '"iPhone Developer"',
                    CODE_SIGN_STYLE: 'Automatic',
                    COPY_PHASE_STRIP: 'NO',
                    DEBUG_INFORMATION_FORMAT: '"dwarf-with-dsym"',
                        DEVELOPMENT_TEAM: 'U6J99X5R3S',
                    ENABLE_NS_ASSERTIONS: 'NO',
                    ENABLE_STRICT_OBJC_MSGSEND: 'YES',
                    GCC_C_LANGUAGE_STANDARD: 'gnu11',                        
                    GCC_NO_COMMON_BLOCKS: 'YES',
                    GCC_WARN_64_TO_32_BIT_CONVERSION: 'YES',
                    GCC_WARN_ABOUT_RETURN_TYPE: 'YES_ERROR',
                    GCC_WARN_UNINITIALIZED_AUTOS: 'YES_AGGRESSIVE',
                    INFOPLIST_FILE: path.join(targetSubfolder, 'Info.plist'),
                    IPHONEOS_DEPLOYMENT_TARGET: '12.1',
                    LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @loader_path/Frameworks"',
                    MTL_ENABLE_DEBUG_INFO: 'NO',
                    MTL_FAST_MATH: 'YES',
                    PRODUCT_BUNDLE_IDENTIFIER: '"com.qbix.ui-test.'+targetName+'"',
                    PRODUCT_NAME: '"$(TARGET_NAME)"',
                    SWIFT_OPTIMIZATION_LEVEL: '"-Owholemodule"',
                    SWIFT_VERSION: '4.2',
                    TARGETED_DEVICE_FAMILY: '"1,2"',
                    TEST_TARGET_NAME: project.productName,
                    VALIDATE_PRODUCT: 'YES'
                },
                name: 'Release',
            }
        ];
    
        // Build Configuration: Add
        var buildConfigurations = project.addXCConfigurationList(buildConfigurationsList, 'Release', 'Build configuration list for PBXNativeTarget "' + targetName +'"');
    
        // Product: Create
        var productName = targetName,
            productType = productType,
            productFileType = "xctest",
            productFile = project.addProductFile(productName+"."+productFileType, { group: 'Copy Files', 'target': targetUuid}),
            productFileName = productFile.basename;
    
    
        // Product: Add to build file list
        project.addToPbxBuildFileSection(productFile);
    
        // Target: Create
        var target = {
                uuid: targetUuid,
                pbxNativeTarget: {
                    isa: 'PBXNativeTarget',
                    buildConfigurationList: buildConfigurations.uuid,
                    buildPhases: [],
                    buildRules: [],
                    dependencies: [],
                    name: targetName,
                    productName: targetName,
                    productReference: productFile.fileRef,
                    productType: '"' + productType + '"',
                }
        };
    
        // Target: Add to PBXNativeTarget section
        project.addToPbxNativeTargetSection(target)
    
        // project.addToPbxFrameworksBuildPhase(file);  

        var newSourceSection = createNewSection(project,"PBXSourcesBuildPhase", "Sources",files);
        var newFrameworkSection = createNewSection(project,"PBXFrameworksBuildPhase", "Frameworks");
        var newResourceSection = createNewSection(project,"PBXResourcesBuildPhase","Resources");
        
        
    
        var targetDependency = addTargetDependency(project, project.getFirstTarget().uuid, [project.getFirstTarget().uuid])
        
        target.pbxNativeTarget.buildPhases.push(newSourceSection.uuid+" /* Sources */");
        target.pbxNativeTarget.buildPhases.push(newFrameworkSection.uuid+" /* Frameworks */");
        target.pbxNativeTarget.buildPhases.push(newResourceSection.uuid+" /* Resources */");
        target.pbxNativeTarget.dependencies.push(targetDependency.value+" /* PBXTargetDependency */");

        // Target: Add uuid to root project
        var newTarget = {
            value: target.uuid,
            comment: target.pbxNativeTarget.name
        };

        project.pbxProjectSection()[project.getFirstProject()['uuid']]['targets'].push(newTarget);
    
        // Return target on success
        return target;
}

function createNewSection(project,sectionName, name, files) {
    var frameworks = project.hash.project.objects[sectionName];
    var rootFramework = undefined;
    for (var key in frameworks){
        if(key.indexOf("_comment") == -1) {
            rootFramework = frameworks[key];
            break;
        }
    }
    var newFrameworkUuid = project.generateUuid()
    var listOfFiles = files != undefined ? files : [];
    var newFramework = {
        isa:sectionName,
        buildActionMask: rootFramework.buildActionMask,
        files: listOfFiles,
        runOnlyForDeploymentPostprocessing: 0
    }
    project.hash.project.objects[sectionName][newFrameworkUuid]= newFramework;
    project.hash.project.objects[sectionName][newFrameworkUuid+"_comment"]= name;

    return {uuid:newFrameworkUuid, section:newFramework}
}

function addTargetDependency(project, target, dependencyTargets) {
    if (!target)
        return undefined;

    var nativeTargets = project.pbxNativeTargetSection();

    if (typeof nativeTargets[target] == "undefined")
        throw new Error("Invalid target: " + target);

    for (var index = 0; index < dependencyTargets.length; index++) {
        var dependencyTarget = dependencyTargets[index];
        if (typeof nativeTargets[dependencyTarget] == "undefined")
            throw new Error("Invalid target: " + dependencyTarget);
        }

    var pbxTargetDependency = 'PBXTargetDependency',
        pbxContainerItemProxy = 'PBXContainerItemProxy',
        pbxTargetDependencySection = project.hash.project.objects[pbxTargetDependency],
        pbxContainerItemProxySection = project.hash.project.objects[pbxContainerItemProxy];

    for (var index = 0; index < dependencyTargets.length; index++) {
        var dependencyTargetUuid = dependencyTargets[index],
            dependencyTargetCommentKey = require('util').format("%s_comment", dependencyTargetUuid),
            targetDependencyUuid = project.generateUuid(),
            targetDependencyCommentKey = require('util').format("%s_comment", targetDependencyUuid),
            itemProxyUuid = project.generateUuid(),
            itemProxyCommentKey = require('util').format("%s_comment", itemProxyUuid),
            itemProxy = {
                isa: pbxContainerItemProxy,
                containerPortal: project.hash.project['rootObject'],
                containerPortal_comment: project.hash.project['rootObject_comment'],
                proxyType: 1,
                remoteGlobalIDString: dependencyTargetUuid,
                remoteInfo: nativeTargets[dependencyTargetUuid].name
            },
            targetDependency = {
                isa: pbxTargetDependency,
                target: dependencyTargetUuid,
                target_comment: nativeTargets[dependencyTargetCommentKey],
                targetProxy: itemProxyUuid,
                targetProxy_comment: pbxContainerItemProxy
            };

        if (pbxContainerItemProxySection && pbxTargetDependencySection) {
            pbxContainerItemProxySection[itemProxyUuid] = itemProxy;
            pbxContainerItemProxySection[itemProxyCommentKey] = pbxContainerItemProxy;
            pbxTargetDependencySection[targetDependencyUuid] = targetDependency;
            pbxTargetDependencySection[targetDependencyCommentKey] = pbxTargetDependency;
            // nativeTargets[target].dependencies.push({ value: targetDependencyUuid, comment: pbxTargetDependency })
        }
    }

    // return { uuid: target, target: nativeTargets[target] };
    return { value: targetDependencyUuid, comment: pbxTargetDependency }
}