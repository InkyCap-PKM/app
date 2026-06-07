#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Démarrage rapide",
  description: "Le chemin le plus rapide entre l'installation d'InkyCap et la création d'une boîte de notes, la rédaction de votre première note et la mise en relation de notes par des liens wiki.",
  tags: ("documentation",),
)

= Démarrage rapide

== Bienvenue dans InkyCap

Cette page est le plus court chemin entre une installation toute neuve et la rédaction et la mise en relation de vos premières notes. Elle est écrite pour les personnes qui n'ont jamais utilisé InkyCap, Typst ni git auparavant. Si vous voulez la vue d'ensemble, #wikilink("1 - Prise en main") et #wikilink("1 - L'interface InkyCap") complètent le décor.

Une *_boîte de notes_* est le dossier où vivent toutes vos notes, et InkyCap travaille toujours à l'intérieur d'une boîte de notes.

#callout("note")[ Une boîte de notes n'est qu'un dossier ordinaire sur votre ordinateur. InkyCap y ajoute une petite zone cachée `.inkycap/` pour les templates, les paramètres et les outils de rédaction. Vos notes y restent de simples fichiers texte portables. ]

== Avant de commencer

Si InkyCap n'est pas encore installé, suivez d'abord #wikilink("2 - Installer InkyCap"), puis revenez ici. Une fois l'application lancée, vous êtes prêt à ouvrir ou créer une boîte de notes.

== Étape 1 — Ouvrir ou créer une boîte de notes

Comme InkyCap ne peut rien faire d'utile sans une #highlight[boîte de notes] active, la toute première chose que vous verrez sur une installation neuve est un écran intitulé *« Ouvrez une boîte de notes pour continuer. »*

Pour démarrer une boîte de notes toute neuve :

+ Cliquez sur *« Ouvrir ou créer une boîte de notes… »*.
+ Le sélecteur de dossiers normal de votre ordinateur s'ouvre (intitulé « Sélectionner le dossier de la boîte de notes »), à partir de votre dossier personnel. Choisissez un dossier vide, ou créez-en un nouveau, où vous voulez.
+ Confirmez votre choix. InkyCap transforme ce dossier en boîte de notes en y mettant discrètement en place son espace de travail `.inkycap/`.

Le dossier est maintenant votre boîte de notes, et l'éditeur principal apparaît.

#callout("note")[ Si vous possédez déjà au moins une autre boîte de notes, InkyCap demande *« Copier depuis une boîte de notes existante ? »* avant d'ouvrir. Choisissez *« Utiliser les valeurs par défaut »* pour repartir à neuf (c'est la valeur par défaut sûre ; appuyer sur Entrée ou Échap la choisit aussi), ou *« Copier et ouvrir »* pour reprendre les paramètres, les templates et les types de propriétés d'une autre boîte de notes. ]

#callout("tip", title: "Pour les utilisatrices et utilisateurs de Typst")[ Le dossier de la boîte de notes devient la racine du projet Typst. Chaque note importe automatiquement la bibliothèque embarquée par un chemin stable et sans numéro de version :
```typ
#import "/.inkycap/notebox.typ": *
```
C'est cette seule ligne qui rend disponibles `#note(...)`, `#wikilink(...)`, `#tag(...)` et les autres primitives de la boîte de notes. Vous ne l'écrivez jamais vous-même. Les nouvelles notes l'incluent depuis leur scaffold. ]

=== Les deux autres façons de démarrer

Créer une boîte de notes neuve est le chemin courant, mais il y en a deux autres, tous deux destinés à rejoindre une boîte de notes que quelqu'un d'autre a partagée pour collaborer avec vous :

- *Cloner depuis un dépôt distant* vous permet de rejoindre une boîte de notes collaborative par son adresse git. Vous n'avez besoin d'aucune connaissance de la ligne de commande.
- *Importer un package* vous permet de rejoindre une boîte de notes qu'une collaboratrice ou un collaborateur vous a remise hors ligne sous forme d'un seul fichier package.

Vous trouverez les trois options réunies plus loin dans #wikilink("2 - Paramètres"), sous l'onglet Aperçu. Pour l'histoire complète du travail avec d'autres personnes, voyez #wikilink("1 - Collaboration"). Si vous avez plutôt des notes existantes que vous aimeriez apporter, #wikilink("2 - Importer des notes existantes") vous guide pas à pas.

Pour une visite guidée de l'aménagement de votre nouvelle boîte de notes, voyez #wikilink("3 - Configurer votre boîte de notes").

== Étape 2 — Écrire votre première note

Appuyez sur *Ctrl+N* pour créer une nouvelle note. (Vous pouvez aussi utiliser le bouton *Nouvelle note* dans l'arborescence de fichiers à gauche, ou faire un clic droit sur un dossier et choisir *Nouvelle note*.)

Une nouvelle note s'ouvre à partir d'un template, contenant déjà quelques champs utiles et un titre, prête à recevoir votre texte. Commencez à écrire sous le titre. Il n'y a rien à configurer au préalable.

#callout("tip")[ Il n'y a pas de bouton ni de raccourci pour enregistrer, et vous n'en avez pas besoin. InkyCap enregistre votre travail automatiquement pendant que vous tapez, et écrit chaque fichier en toute sécurité pour que vous ne vous retrouviez jamais avec une note à moitié enregistrée. ]

Vous écrivez avec le balisage léger de Typst (par exemple `*gras*`, `_italique_`, `= Titre`, et `- ` pour une liste à puces). #wikilink("3 - Mettre en forme votre texte") couvre l'ensemble complet, et #wikilink("2 - Modifier des notes") explique les gestes quotidiens de l'éditeur.

#callout("important")[ InkyCap lit le balisage Typst, pas le Markdown. Utilisez `*gras*` (une seule astérisque) et `= Titre` (un signe égal). Les habitudes Markdown comme `**gras**` ou `# Titre` ne seront pas mises en forme. Elles apparaîtront littéralement. ]

== Étape 3 — Relier les notes entre elles

La mise en relation est au cœur de votre navigation dans InkyCap. Pour relier une note à une autre, tapez deux crochets :

```typ
[[
```

Un sélecteur apparaît et suggère les noms de vos notes existantes. Choisissez-en une, et InkyCap y insère un lien. (En coulisses, cela devient un appel `#wikilink(...)`, mais vous verrez et taperez habituellement simplement la forme `[[Nom]]`.) Si vous tapez le nom d'une note qui n'existe pas encore, votre lien wiki apparaîtra, prêt à servir. Cliquez dessus et la nouvelle note sera créée avec le nom de votre page pour que vous puissiez commencer à y écrire.

Chaque lien que vous faites est automatiquement bidirectionnel. Quand vous reliez la note A à la note B, la note B gagne un _rétrolien_ qui pointe vers A. Avec le temps, cette toile de connexions devient une carte de votre pensée et fait en sorte que toute l'information liée au sujet d'une note s'organise automatiquement. Voyez #wikilink("4 - Liens et rétroliens") pour aller plus loin.

#callout("example")[ Pendant que vous rédigez une note de lecture, tapez `[[`, puis commencez à taper le titre de votre note de méthodes. Choisissez-la dans la liste. Votre note de lecture renvoie maintenant à la note de méthodes, et la note de méthodes affiche automatiquement votre note de lecture dans ses rétroliens. ]

== Étape 4 — Activer les sauvegardes automatiques

InkyCap peut conserver des sauvegardes compressées de toute votre boîte de notes pendant que vous travaillez. Les sauvegardes sont activées par défaut, mais elles ne commencent à s'exécuter qu'une fois que vous indiquez à InkyCap _où_ les déposer.

+ Ouvrez #wikilink("2 - Paramètres") (*Ctrl+,*).
+ Allez à l'onglet *Importation/Exportation et sauvegarde* et trouvez *Sauvegarde de la boîte de notes*.
+ Définissez un *Dossier de destination* (quelque part en dehors de votre boîte de notes, comme un disque externe ou un dossier infonuagique synchronisé).

Une fois une destination définie, InkyCap fait des sauvegardes selon un horaire (toutes les 24 heures par défaut) et conserve les quelques archives les plus récentes. Vous pouvez aussi sauvegarder à la demande avec le bouton *Sauvegarder maintenant*, ou depuis la palette de commandes (*Ctrl+P*, puis « Sauvegarder la boîte de notes maintenant »).

#callout("warning")[ Vous pouvez protéger les sauvegardes par mot de passe avec un chiffrement fort, mais si vous perdez ce mot de passe, la sauvegarde ne peut pas être récupérée. Il n'y a aucune réinitialisation. ]

La page #wikilink("2 - Paramètres") explique chaque option de sauvegarde, y compris la rétention, le chiffrement et la restauration à partir d'une archive.

== Vous êtes fin prêt

Vous avez maintenant une boîte de notes, une première note, votre premier lien et un filet de sécurité. À partir d'ici :

- Familiarisez-vous avec l'espace de travail dans #wikilink("1 - L'interface InkyCap").
- Apprenez les commandes de l'éditeur dans #wikilink("2 - Modifier des notes").
- Bâtissez votre bibliothèque connectée avec #wikilink("4 - Liens et rétroliens").

== Pages connexes

- #wikilink("2 - Installer InkyCap")
- #wikilink("3 - Configurer votre boîte de notes")
- #wikilink("1 - L'interface InkyCap")
- #wikilink("2 - Modifier des notes")
- #wikilink("3 - Mettre en forme votre texte")
- #wikilink("4 - Liens et rétroliens")
- #wikilink("2 - Importer des notes existantes")
- #wikilink("1 - Collaboration")
- #wikilink("2 - Paramètres")
