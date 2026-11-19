# Card Studio

Éditeur de cartes personnalisées **100 % hors ligne** pour PC (Windows, macOS, toutes les distributions Linux) et Android. Il reprend l'éditeur « Creator » de mtgcardbuilder.com : même moteur de rendu, mêmes onglets, mêmes options.

Usage personnel uniquement. Non affilié à Wizards of the Coast, ni sponsorisé ou approuvé par eux.

## Installer

Télécharge le fichier de ton système dans la dernière **[Release](https://github.com/Vagharlix/MTGCardBuilder/releases/latest)**, section « Assets ».

| Système | Fichier | Remarque |
|---|---|---|
| Windows | `Card.Studio_x.y.z_x64-setup.exe` ou `.msi` | Si SmartScreen s'affiche : « Informations complémentaires → Exécuter quand même ». |
| macOS (Apple Silicon) | `Card.Studio_x.y.z_aarch64.dmg` | L'app n'est pas signée : la première fois, clic droit → Ouvrir. Si macOS refuse encore : `xattr -cr "/Applications/Card Studio.app"`. |
| Linux (toutes distributions) | `Card.Studio_x.y.z_amd64.AppImage` | `chmod +x Card.Studio_*.AppImage` puis double-clic. |
| Debian / Ubuntu / Mint | `.deb` | `sudo apt install ./Card.Studio_*.deb` |
| Fedora / openSUSE | `.rpm` | `sudo dnf install ./Card.Studio-*.rpm` |
| Android (arm64) | `Card-Studio-main-arm64.apk` | Autorise l'installation d'applis inconnues pour ton navigateur ou ton gestionnaire de fichiers. |

Pas de version pour Mac Intel, iPhone ni iPad.

**Mise à jour** : installe la nouvelle version par-dessus l'ancienne.

**Ta galerie** est enregistrée en vrais fichiers. Par défaut : **Documents/Card Studio** sur PC, le stockage de l'app sur Android. Pour la garder même en désinstallant l'app, ou la retrouver sur un autre appareil, choisis un dossier dans **Gallery → Change folder** (les cartes déjà enregistrées y sont copiées). Sur le nouvel appareil, copie ce dossier puis choisis-le de la même façon.

Les images exportées sur Android vont dans **Téléchargements/Card Studio**.

## Fonctionnalités

- **Frame** : les mêmes groupes et packs de cadres que mtgcardbuilder.com, près de 380 packs (Regular, Tokens, Sagas et Saga Creatures, Planeswalkers, Transform, Modal DFC, Stations, Rooms, Omens, Prepare, Showcase dont Neon Ink, Pixel, Draconic, Paranormal, Japan Showcase…, Universes Beyond, Promos, Textless, cadres Custom dont StoneCutter et les 1/8th, anciens cadres…), avec leurs onglets spéciaux (Station, Saga, Class, Planeswalker…), recherche, *Load Frame Version*, *Rotate Frame*, *Auto load*, import de cadres perso, masques, ajout pleine carte / moitié droite / moitié gauche / centre, calques (glisser pour réordonner, clic pour opacité, position, teinte, masques). Les cadres **violets** et autres cadres « custom » de mtgcardbuilder.com sont inclus dans les 101 packs où le site les propose, en fin de liste comme sur le site (« Purple », « Purple PT », « Purple Crown »…).
- **Text** : toutes les zones de texte, codes de mise en forme et de mana (dont `{purple}`), barre de symboles rapide, gras / italique, position, taille de zone et taille de police au curseur, ajout d'un surnom, d'un F/E ou d'une date.
- **Art** : import (fichier, glisser-déposer, URL), déplacement à la souris ou au doigt, pincer pour zoomer, Maj + glisser pour l'échelle, Ctrl + glisser pour la rotation, *Auto Fit*, niveaux de gris.
- **Set Symbol** : 291 extensions disponibles hors ligne, avec la rareté, ou ton propre symbole.
- **Watermark** : galerie avec recherche et catégories (guildes, clans, écoles, familles…), 434 symboles d'extension, couleurs gauche/droite, opacité, position.
- **Collector** : numéro, rareté, extension, langue, artiste, année, numéro de série, étoile ou point, valeurs par défaut.
- **Import/Preset** : presets à partir de ta galerie (par catégorie), import d'une vraie carte depuis Scryfall (nécessite Internet), sauvegarde, chargement, export et import `.cardconjurer`.
- **Save and Update Gallery**, **Download image** (PNG 2010×2814 ou JPEG), **Create Card Back**.
- **Galerie** en fichiers, dans le dossier de ton choix : une carte = un fichier `.cardconjurer` (importable dans l'app sur un autre appareil) et son image `.jpg`. *Import File* accepte plusieurs fichiers à la fois.
- **Print PDF** : planche A4 ou Letter, cartes à 63×88 mm, traits de coupe, fond perdu.
- **Sur la carte** : choisis ce que le glissement déplace (illustration, texte, symbole, filigrane). Toucher un texte le sélectionne, glisser le déplace, pincer (ou Maj + glisser) change sa taille.
- **Curseurs** à côté de chaque position, taille, opacité et échelle (illustration, textes, symbole, filigrane, numéro de série, calques).
- **Mise en page adaptative** : sur un écran large (ordinateur, tablette, téléphone pliable déplié, téléphone à l'horizontale), les réglages sont à côté de la carte. Sur un téléphone en portrait, ils passent dessous et la carte reste épinglée en haut (3 tailles d'aperçu), avec les onglets en bande et une barre d'actions en bas.
- Sauvegarde automatique de la carte en cours, thème sombre ou clair.
