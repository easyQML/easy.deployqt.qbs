// SPDX-FileCopyrightText: © 2024 Serhii “GooRoo” Olendarenko
//
// SPDX-License-Identifier: BSD-3-Clause

const FileInfo = require('qbs.FileInfo')
const Process = require('qbs.Process')
const TextFile = require('qbs.TextFile')

function unionSets(lhs, rhs) {
	var union = new Set(lhs)
	rhs.forEach(function (elem) {
		union.add(elem)
	})
	return union
}

function pluginNameToFileName(libName, os) {
	if (os.contains('windows')) {
		return libName + '.dll'
	} else if (os.contains('macos')) {
		return 'lib' + libName + '.dylib'
	}
}

function getRuntimeDependenciesMacOS(libPath, dynamicLib, arch) {
	const otool = new Process()
	const args = ['-L', dynamicLib, '-arch', arch]

	otool.exec('otool', args, true)
	const deps = otool.readStdOut()

	return parseOtoolOutput(
		dynamicLib,
		deps
	)
		.filter(function (dep) { return dep.startsWith('@rpath/Qt') })
		.map(function (dep) {
			return FileInfo.joinPaths(
				libPath,
				dep.match(/^@rpath\/((.+)\.framework\/Versions\/A\/\2$)/)[1]
			)
		})
}

//! Use `dumpbin.exe` to get the runtime dependencies of a dynamic library on Windows.
//
// The output of `dumpbin` is of the following format (example):
// ```
//
// Dump of file .\Qt6Qml.dll
//
// File Type: DLL
//
//   Image has the following dependencies:
//
//     Qt6Network.dll
//     SHELL32.dll
//     Qt6Core.dll
//     KERNEL32.dll
//     MSVCP140.dll
//     VCRUNTIME140.dll
//     VCRUNTIME140_1.dll
//     api-ms-win-crt-heap-l1-1-0.dll
//     api-ms-win-crt-math-l1-1-0.dll
//     api-ms-win-crt-stdio-l1-1-0.dll
//     api-ms-win-crt-runtime-l1-1-0.dll
//     api-ms-win-crt-string-l1-1-0.dll
//
//   Summary
//
//        20000 .data
//        2E000 .pdata
//       142000 .rdata
//         8000 .reloc
//         1000 .rsrc
//       367000 .text
// ```
function getRuntimeDependenciesWindows(toolchainPath, libPath, dynamicLib) {
	const dumpbin = new Process()
	const args = ['/nologo', '/dependents', dynamicLib]

	dumpbin.exec(FileInfo.joinPaths(toolchainPath, 'dumpbin.exe'), args, true)
	const output = dumpbin.readStdOut()

	const outLines = output.split('\n')
	const blockStart = outLines.indexOf('  Image has the following dependencies:') + 2
	const blockEnd = outLines.indexOf('', blockStart)

	return outLines.slice(blockStart, blockEnd)
		.map(function (line) { return line.trim() })
		.filter(function (line) { return line.startsWith('Qt6') })
		.map(function (dep) { return FileInfo.joinPaths(libPath, dep) })
}

function getRecursiveRuntimeDependencies(os, toolchainPath, libPath, dynamicLib, arch, visited) {
	visited = visited || new Set();

	if (visited.has(dynamicLib)) {
		return new Set();
	}

	visited.add(dynamicLib);

	var directDependencies = new Set(
		os.contains('windows')
			? getRuntimeDependenciesWindows(toolchainPath, libPath, dynamicLib)
			: getRuntimeDependenciesMacOS(libPath, dynamicLib, arch)
	);
	var allDependencies = new Set(directDependencies);

	directDependencies.forEach(function (dependency) {
		var recursiveDependencies = getRecursiveRuntimeDependencies(os, toolchainPath, libPath, dependency, arch, visited);
		allDependencies = unionSets(allDependencies, recursiveDependencies);
	});

	return allDependencies;
}

function frameworkLibToFrameworkContents(frameworkLibPath) {
	const match = frameworkLibPath.match(/^(.+\/(.+)\.framework)\/.+\/\2$/)
	if (!match) {
		throw new Error('Invalid framework library path: ' + frameworkLibPath)
	}

	const frameworkPath = match[1]
	const frameworkName = match[2]

	const versionsPath = frameworkPath + '/Versions'
	const versionName = 'A'
	const versionPath = versionsPath + '/' + versionName

	var list = []

	list.push(frameworkPath + '/' + frameworkName)
	list.push(frameworkPath + '/Resources')
	list.push(versionsPath + '/Current')
	list.push(versionPath + '/Resources/Info.plist')
	list.push(versionPath + '/' + frameworkName)

	return list
}

//! Parse the `otool -L` output of the following format (example):
// ```
// ../Imports/Qt/labs/platform/liblabsplatformplugin.dylib:
//     @rpath/QtLabsPlatform.framework/Versions/A/QtLabsPlatform (compatibility version 6.0.0, current version 6.8.0)
//     @rpath/QtQml.framework/Versions/A/QtQml (compatibility version 6.0.0, current version 6.8.0)
//     @rpath/QtNetwork.framework/Versions/A/QtNetwork (compatibility version 6.0.0, current version 6.8.0)
//     @rpath/QtCore.framework/Versions/A/QtCore (compatibility version 6.0.0, current version 6.8.0)
//     /System/Library/Frameworks/IOKit.framework/Versions/A/IOKit (compatibility version 1.0.0, current version 275.0.0)
//     /System/Library/Frameworks/DiskArbitration.framework/Versions/A/DiskArbitration (compatibility version 1.0.0, current version 1.0.0)
//     /System/Library/Frameworks/UniformTypeIdentifiers.framework/Versions/A/UniformTypeIdentifiers (compatibility version 1.0.0, current version 709.0.0)
//     /usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1700.255.0)
//     /usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.100.2)
// ```
function parseOtoolOutput(dynamicLib, output) {
	const lines = output.split('\n')

	const deps = []

	if (!lines[0].startsWith(dynamicLib)) {
		throw new Error('Cannot parse otool output: ' + lines[0])
	}

	// Starting from 1 since lines[0] is the name of the library we explore
	for (var i = 1; i < lines.length; ++i) {
		const line = lines[i]

		const depMatch = line.match(/^\s+(.+) \(compatibility version \d+\.\d+\.\d+, current version \d+\.\d+\.\d+\)$/)

		if (depMatch) {
			deps.push(depMatch[1])
		} else if (line.trim() !== '') {
			console.error('Unmatched dependency: ' + line)
		}
	}

	return deps
}

function collectQmlImports(scannerFilePath, qrcFiles, importPath, os) {
	const qmlimportscanner = new Process()
	var args = qrcFiles.reduce(function (acc, input) {
		acc.push(input.filePath)
		return acc
	}, ['-qrcFiles'])
	args.push('-importPath', importPath)

	qmlimportscanner.exec(scannerFilePath, args, true)
	const imports = JSON.parse(qmlimportscanner.readStdOut())
		.filter(function (imp) { return imp.plugin && imp.name.startsWith('Qt') })
		.map(function (imp) {
			return {
				name: imp.name,
				path: FileInfo.joinPaths(imp.path, pluginNameToFileName(imp.plugin, os)),
			}
		})

	return imports
}

function getLibFilesForQtModule(Qt, mod) {
	if ((mod !== 'core') && !Qt[mod].hasLibrary)
		return []

	if (Qt[mod].isStaticLibrary)
		return []

	var list = []
	if (qbs.targetOS.contains('windows')) {
		const dir = Qt.core.binPath
		const basename = FileInfo.baseName(Qt[mod].libNameForLinker)
		const suffix = qbs.buildVariant === 'debug' ? 'd' : ''
		const libPath = FileInfo.joinPaths(dir, basename + suffix + '.dll')
		list.push(libPath)
	} else if (Qt.core.frameworkBuild) {
		const fp = Qt[mod].libFilePathRelease

		const suffix = '.framework/'
		const frameworkPath = fp.substr(0, fp.lastIndexOf(suffix) + suffix.length - 1)
		const versionsPath = frameworkPath + '/Versions'
		const versionName = 'A'
		const versionPath = versionsPath + '/' + versionName
		list.push(frameworkPath + '/' + FileInfo.fileName(fp))
		list.push(frameworkPath + '/Resources')
		list.push(versionsPath + '/Current')
		list.push(versionPath + '/Resources/Info.plist')
		list.push(versionPath + '/' + FileInfo.fileName(fp))
	}
	return list
}

function readDepsFromFile(filePath) {
	console.debug('Reading dependencies from ' + filePath)
	var depsFile = new TextFile(filePath, TextFile.ReadOnly)
	const deps = depsFile.readAll().split('\n').filter(function (line) { return line.trim() !== '' })
	depsFile.close()

	return deps
}

function readDepsForTags(inputs, tags) {
	return tags.reduce(function (acc, tag) {
		if (inputs[tag] !== undefined) {
			acc = unionSets(acc, readDepsFromFile(inputs[tag][0].filePath))
		}
		return acc
	}, new Set())
}

function readQmlImports(filePath) {
	var importsFile = new TextFile(filePath, TextFile.ReadOnly)
	const imports = JSON.parse(importsFile.readAll())
	importsFile.close()
	return imports
}

function toTargetPath(filePath, fromDir, installDir) {
	return filePath.replace(
		fromDir,
		FileInfo.joinPaths(
			product.qbs.installRoot,
			project.installContentsPath,
			installDir
		)
	)
}

function collectAssets(dir) {
	const dirs = File.directoryEntries(dir, File.Dirs | File.NoDotAndDotDot);
	const files = File.directoryEntries(dir, File.Files)
		.filter(function (entry) {
			return entry.match(/\.(png|webp|qsb)$/)
		})
		.map(function (entry) {
			return FileInfo.joinPaths(dir, entry);
		})

	return dirs
		.filter(function (subdir) { return subdir !== 'designer' })
		.filter(function (subdir) { return !File.exists(FileInfo.joinPaths(dir, subdir, 'qmldir')) })
		.reduce(function (acc, subdir) {
			return acc.concat(collectAssets(FileInfo.joinPaths(dir, subdir)))
		}, files);
}

function pluginNamesToFileNames(pluginNames, os) {
	return pluginNames.map(function (name) {
		const pathParts = name.split('/')

		if (pathParts.length !== 2) {
			throw Error('Please, specify plugins in format "plugintype/pluginname".')
		}

		const pluginType = pathParts[0]
		const pluginName = pathParts[1]

		return FileInfo.joinPaths(pluginType, pluginNameToFileName(pluginName, os))
	})
}
