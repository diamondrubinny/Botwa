plugins { id("com.android.application") }

fun prop(name: String): String = (project.findProperty(name) ?: error("missing $name")).toString()

android {
    namespace = "net.rubinny.botwa"
    compileSdk = 36

    defaultConfig {
        applicationId = prop("botwa.appId")
        minSdk = 24
        targetSdk = 35
        versionCode = prop("botwa.versionCode").toInt()
        versionName = prop("botwa.versionName")
        resValue("string", "app_name", prop("botwa.appName"))
        resValue("string", "default_url", prop("botwa.url"))
        // where the app looks for a newer version of itself (published by .github/workflows/android.yml); empty = never
        resValue("string", "update_url", prop("botwa.updateUrl"))
    }

    // Release signing from environment variables only (never from files in the repository).
    val ks = System.getenv("BOTWA_KEYSTORE")
    signingConfigs {
        if (ks != null) create("release") {
            storeFile = file(ks)
            storePassword = System.getenv("BOTWA_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("BOTWA_KEY_ALIAS") ?: "botwa"
            keyPassword = System.getenv("BOTWA_KEY_PASSWORD") ?: System.getenv("BOTWA_KEYSTORE_PASSWORD")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (ks != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
}
