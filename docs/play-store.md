# Publier Lumenwild sur Google Play

Ce qui est prêt dans le dépôt, et ce que seul le titulaire du compte peut
faire. Les étapes sont dans l'ordre où Google les demande.

## Ce que le dépôt fournit

| Élément                         | Où                                                                    |
| ------------------------------- | --------------------------------------------------------------------- |
| Projet Android (Capacitor 8)    | `mobile/android/` — API cible 36, minimum Android 7 (API 24)          |
| APK de test (debug)             | workflow **Android**, artefact `lumenwild-debug-apk`                  |
| Bundle de publication (`.aab`)  | workflow **Release builds** (manuel), job `android`                   |
| Icônes (adaptative, ronde, 512) | générées par `node scripts/generate-icons.mjs`                        |
| Image de présentation 1024×500  | `store/play/feature-graphic-1024x500.png`                             |
| Titre et descriptions FR / EN   | `store/play/metadata/<langue>/`                                       |
| Captures d'écran 16:9           | `docs/screenshots/*.jpg` (régénérables, voir plus bas)                |
| Politique de confidentialité    | `public/privacy.html`, en ligne à l'adresse du site + `/privacy.html` |

L'application est une coquille autour du même build web : plein écran
immersif, paysage, écran maintenu allumé, et le bouton Retour met le jeu
en pause au lieu de le quitter.

## 1. Avant le premier envoi : ce qui ne se change plus

- **L'identifiant d'application.** Il vaut `com.lumenwild.game`. Remplacez-le
  par un nom de domaine inversé que vous contrôlez, dans
  `mobile/capacitor.config.json`, `mobile/android/app/build.gradle`
  (`namespace` et `applicationId`), `strings.xml` et le dossier du
  `MainActivity.java`. Après le premier envoi, il est définitif.
- **Le nom.** « Lumenwild » est un titre de travail : vérifiez qu'il est
  libre (INPI, EUIPO, recherche sur Google Play). N'utilisez jamais
  « Minecraft » dans le titre, la description, les mots-clés ou les
  images : c'est une marque déposée et un motif de retrait immédiat.
- **Gratuit ou payant.** Une application publiée gratuite ne peut plus
  devenir payante. Décidez avant.

## 2. Le compte

- Compte Google Play Console : 25 $ une seule fois.
- **Compte personnel créé après novembre 2023** : Google exige un test
  fermé avec au moins 12 testeurs pendant 14 jours consécutifs avant
  d'autoriser la mise en production. Comptez donc au moins deux semaines
  entre le premier envoi et la sortie. Un compte d'organisation (société)
  n'a pas cette contrainte.
- Vérification d'identité, et pour vendre : un profil de paiement.

## 3. La clé d'envoi

Rien de secret n'est dans le dépôt. Créez la clé une fois, sur votre
machine, et gardez-la hors de Git :

```sh
keytool -genkeypair -v -keystore upload.jks -alias upload \
  -keyalg RSA -keysize 4096 -validity 10000
```

Activez **Play App Signing** dans la console (Google garde la clé finale ;
la vôtre ne sert qu'à l'envoi et peut être remplacée en cas de perte).

Pour que le workflow signe le bundle, ajoutez ces secrets dans
_Settings → Environments → release_ (avec validation manuelle requise) :

| Secret                      | Contenu                 |
| --------------------------- | ----------------------- |
| `ANDROID_KEYSTORE_BASE64`   | `base64 -w0 upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | mot de passe du fichier |
| `ANDROID_KEY_ALIAS`         | `upload`                |
| `ANDROID_KEY_PASSWORD`      | mot de passe de la clé  |

Sans ces secrets, le bundle sort non signé (inutilisable sur Play).

## 4. Construire

- **En CI** : _Actions → Release builds → Run workflow_, puis téléchargez
  l'artefact `android-release-bundle`.
- **En local** (Android Studio ou SDK installé) :

  ```sh
  npm ci && npm run build:native
  cd mobile && npm ci
  LUMENWILD_KEYSTORE=/chemin/upload.jks LUMENWILD_KEYSTORE_PASSWORD=… \
  LUMENWILD_KEY_ALIAS=upload LUMENWILD_KEY_PASSWORD=… npm run android:bundle
  ```

À chaque nouvel envoi, augmentez `versionCode` (entier) et `versionName`
dans `mobile/android/app/build.gradle`.

## 5. La fiche

- Titre, description courte et longue : `store/play/metadata/fr-FR` et
  `en-US`.
- Icône 512 : `store/play/icon-512.png`. Image de présentation :
  `store/play/feature-graphic-1024x500.png`.
- Captures : au moins deux, 16:9. Celles de `docs/screenshots/`
  conviennent (`hero-dusk`, `night-lanterns`, `vista`, `forest`, `rain`,
  `snow`, `cave-crystals`). Pour en refaire :
  `node scripts/screenshot.mjs` (voir l'en-tête du script).
- Catégorie : Jeux → Simulation (ou Aventure).
- Adresse e-mail de contact : obligatoire, et publique.

## 6. Les déclarations

- **Politique de confidentialité** : indiquez l'URL de `privacy.html` sur
  votre site. Elle renvoie à « l'adresse de contact de la fiche » : si vous
  préférez y écrire une adresse précise, modifiez `public/privacy.html`.
- **Sécurité des données** : l'application ne collecte et ne partage
  aucune donnée. Répondez « Non » à la collecte et au partage. Les
  sauvegardes restent sur l'appareil.
- **Autorisations** : seule `INTERNET` est déclarée — le composant WebView
  d'Android en a besoin pour afficher les fichiers embarqués — et le jeu
  n'émet aucune requête réseau.
- **Classification du contenu** (questionnaire IARC) : pas de violence,
  pas de langage grossier, pas d'achats, pas d'interaction entre joueurs.
  Le résultat attendu est « tout public » (PEGI 3).
- **Public cible** : si vous incluez les moins de 13 ans, l'application
  relève du **programme Familles**. Elle en respecte les exigences
  techniques : aucune publicité, aucun SDK tiers, aucune collecte, aucun
  lien sortant, aucun achat intégré. Tout ajout ultérieur (publicité,
  statistiques, achats) devra passer par des SDK certifiés Familles et
  mettre à jour ces déclarations.

## 7. Tester avant de publier

1. Installez l'APK debug (artefact du workflow **Android**) sur de vrais
   téléphones : un récent et un ancien.
2. Vérifiez la fluidité (réglages → « Afficher les performances »), les
   commandes tactiles, la reprise après mise en veille, le bouton Retour.
3. Envoyez le bundle en **test interne**, puis en **test fermé** (les 12
   testeurs / 14 jours si le compte est personnel).
4. Lisez le **rapport pré-lancement** de Google (plantages, accessibilité).

## Ce qui n'a pas été vérifié

Le projet Android est compilé par la CI de GitHub, mais l'APK n'a été
installé sur aucun appareil ni émulateur depuis ce dépôt : fluidité réelle,
comportement du mode immersif selon les marques, bouton Retour et reprise
après veille restent à contrôler à l'étape 7. iOS n'a pas été tenté.
